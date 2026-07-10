//! Normalized `SQLite` persistence for autoresponder scenarios and rules.
//!
//! The frontend and common mutations never rewrite a monolithic JSON document:
//! scenario metadata, rule ordering and each full rule payload are stored in
//! separate rows. Summary columns keep list metadata queryable without parsing
//! response bodies.

use std::path::{Path, PathBuf};

use proxy_core::{
    Action, AutoResponder, MatchKind, Rule, Scenario, GENERAL_SCENARIO_ID, GENERAL_SCENARIO_NAME,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

const DB_FILE: &str = "autoresponder.sqlite3";
const SORT_STEP: f64 = 1024.0;

pub struct RuleStore {
    path: PathBuf,
    /// Viewer instances (`--viewer`) share this file with the capturing one, so
    /// they load + display scenarios but never persist edits — otherwise a
    /// viewer's writes would race the capturing instance's full-rewrite
    /// `replace`, silently clobbering rules (issue #71). Every mutating method
    /// is a no-op when set; the in-memory `AutoResponder` still updates so the
    /// viewer's own UI stays consistent for the session.
    read_only: bool,
}

impl RuleStore {
    pub fn open(dir: &Path, read_only: bool) -> Result<(Self, AutoResponder), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let store = Self {
            path: dir.join(DB_FILE),
            read_only,
        };
        let mut connection = store.connect()?;
        // Self-heal a database written by an older build: if the `rules` table has
        // a different shape than the current schema (e.g. the pre-#74 `name`
        // column), `CREATE TABLE IF NOT EXISTS` would leave it as-is and every rule
        // insert would fail against the stale constraint. Rebuild the autoresponder
        // tables instead. A viewer opens read-only and must never mutate the shared
        // DB, so only the writable (capturing) instance heals.
        if !read_only && Self::rules_schema_stale(&connection)? {
            Self::rebuild_schema(&mut connection)?;
        } else {
            Self::create_schema(&connection)?;
        }
        let autoresponder = Self::load_with_connection(&connection)?;
        // Persist the built-in General scenario row for a writable instance so a
        // rule inserted into it later has a valid parent (the FK). `load_*`
        // already guarantees it in-memory via `ensure_general`; this makes the
        // seeded row durable. INSERT OR IGNORE keeps an existing one untouched.
        if !read_only {
            connection
                .execute(
                    "INSERT OR IGNORE INTO scenarios (id, name, sort_key) VALUES (?1, ?2, ?3)",
                    params![GENERAL_SCENARIO_ID, GENERAL_SCENARIO_NAME, -SORT_STEP],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok((store, autoresponder))
    }

    /// The columns the current `rules` schema defines. There is deliberately no
    /// autoresponder migration path, so an on-disk table whose columns differ from
    /// this is treated as coming from an older build and rebuilt (not migrated).
    const RULES_COLUMNS: &[&str] = &[
        "id",
        "scenario_id",
        "sort_key",
        "enabled",
        "fire_limit",
        "repeat",
        "method",
        "url",
        "url_match",
        "action_kind",
        "action_status",
        "action_content_type",
        "action_name",
        "rule_json",
    ];

    /// Whether an existing `rules` table's columns differ from [`Self::RULES_COLUMNS`].
    /// A missing table (a brand-new DB) is not stale — `create_schema` builds it.
    fn rules_schema_stale(connection: &Connection) -> Result<bool, String> {
        let mut statement = connection
            .prepare("PRAGMA table_info(rules)")
            .map_err(|e| e.to_string())?;
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        if columns.is_empty() {
            return Ok(false);
        }
        let current = columns.len() == Self::RULES_COLUMNS.len()
            && Self::RULES_COLUMNS
                .iter()
                .all(|expected| columns.iter().any(|actual| actual == expected));
        Ok(!current)
    }

    /// Rebuild the autoresponder tables from an older build's schema, preserving the
    /// rules via their stored `rule_json` when the old rows are still readable
    /// (unreadable rows are skipped — schema changes may discard old dev data).
    /// Drop + create + re-insert run in ONE transaction (`SQLite` DDL is
    /// transactional), so a crash or a re-insert the new constraints reject
    /// rolls back to the untouched old database instead of destroying it.
    fn rebuild_schema(connection: &mut Connection) -> Result<(), String> {
        tracing::warn!("autoresponder database is from an older build; rebuilding its schema");
        let preserved = Self::load_with_connection(connection).ok();
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute_batch(
                "DROP TABLE IF EXISTS rules;
                 DROP TABLE IF EXISTS scenarios;
                 DROP TABLE IF EXISTS metadata;",
            )
            .map_err(|e| e.to_string())?;
        Self::create_schema(&transaction)?;
        if let Some(existing) = preserved {
            Self::replace_in_transaction(&transaction, &existing)?;
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    fn connect(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.path).map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 -- A viewer instance shares this DB with the capturing one; wait
                 -- out a transient write lock instead of failing a mutation with a
                 -- raw \"database is locked\" surfaced to the UI.
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(|e| e.to_string())?;
        Ok(connection)
    }

    fn create_schema(connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                 );
                 CREATE TABLE IF NOT EXISTS scenarios (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sort_key REAL NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS rules (
                    id TEXT PRIMARY KEY,
                    scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
                    sort_key REAL NOT NULL,
                    enabled INTEGER NOT NULL,
                    fire_limit INTEGER,
                    repeat INTEGER NOT NULL,
                    method TEXT,
                    url TEXT NOT NULL,
                    url_match TEXT NOT NULL,
                    action_kind TEXT NOT NULL,
                    action_status INTEGER,
                    action_content_type TEXT,
                    action_name TEXT,
                    rule_json TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS rules_scenario_order
                 ON rules(scenario_id, sort_key);",
            )
            .map_err(|e| e.to_string())
    }

    pub fn load(&self) -> Result<AutoResponder, String> {
        Self::load_with_connection(&self.connect()?)
    }

    fn load_with_connection(connection: &Connection) -> Result<AutoResponder, String> {
        let active_scenario_id = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'active_scenario_id'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        // Absent (older DB or never toggled) means on — the General layer
        // defaults to active. Only an explicit "0" turns it off.
        let general_active = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'general_active'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .is_none_or(|v| v != "0");

        let mut scenarios_statement = connection
            .prepare("SELECT id, name FROM scenarios ORDER BY sort_key")
            .map_err(|e| e.to_string())?;
        let scenario_rows = scenarios_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        let mut scenarios = Vec::new();
        for scenario_row in scenario_rows {
            let (id, name) = scenario_row.map_err(|e| e.to_string())?;
            let mut rules_statement = connection
                .prepare("SELECT rule_json FROM rules WHERE scenario_id = ?1 ORDER BY sort_key")
                .map_err(|e| e.to_string())?;
            let rows = rules_statement
                .query_map([&id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut rules = Vec::new();
            for row in rows {
                let json = row.map_err(|e| e.to_string())?;
                // A row that no longer deserializes (corruption, or a newer
                // build's unknown Action variant) must not block the whole load
                // — a bad rule would otherwise abort app launch. Skipping means
                // a later full-rewrite `replace` drops that row for good;
                // losing one unreadable rule beats refusing to start.
                match serde_json::from_str(&json) {
                    Ok(rule) => rules.push(rule),
                    Err(error) => tracing::warn!(
                        scenario = %id,
                        %error,
                        "skipping a rule whose stored rule_json no longer deserializes"
                    ),
                }
            }
            scenarios.push(Scenario { id, name, rules });
        }

        let mut autoresponder = AutoResponder {
            scenarios,
            active_scenario_id,
            general_active,
        };
        // Guarantee the built-in General scenario exists and sits first, even
        // for a DB written before this feature existed.
        autoresponder.ensure_general();
        Ok(autoresponder)
    }

    pub fn replace(&self, autoresponder: &AutoResponder) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        Self::replace_with_connection(&mut connection, autoresponder)
    }

    fn replace_with_connection(
        connection: &mut Connection,
        autoresponder: &AutoResponder,
    ) -> Result<(), String> {
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        Self::replace_in_transaction(&transaction, autoresponder)?;
        transaction.commit().map_err(|e| e.to_string())
    }

    fn replace_in_transaction(
        transaction: &Transaction<'_>,
        autoresponder: &AutoResponder,
    ) -> Result<(), String> {
        transaction
            .execute_batch("DELETE FROM rules; DELETE FROM scenarios; DELETE FROM metadata;")
            .map_err(|e| e.to_string())?;
        for (scenario_index, scenario) in autoresponder.scenarios.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO scenarios (id, name, sort_key) VALUES (?1, ?2, ?3)",
                    params![scenario.id, scenario.name, sort_key(scenario_index)],
                )
                .map_err(|e| e.to_string())?;
            for (rule_index, rule) in scenario.rules.iter().enumerate() {
                insert_rule_row(
                    transaction,
                    &scenario.id,
                    sort_key(rule_index),
                    rule,
                )?;
            }
        }
        set_active_metadata(transaction, autoresponder.active_scenario_id.as_deref())?;
        set_general_metadata(transaction, autoresponder.general_active)?;
        Ok(())
    }

    pub fn set_general_active(&self, active: bool) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        set_general_metadata(&transaction, active)?;
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn set_active_scenario(&self, scenario_id: Option<&str>) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        set_active_metadata(&transaction, scenario_id)?;
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn insert_scenario(&self, scenario: &Scenario) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let connection = self.connect()?;
        let last = connection
            .query_row("SELECT MAX(sort_key) FROM scenarios", [], |row| {
                row.get::<_, Option<f64>>(0)
            })
            .map_err(|e| e.to_string())?
            .unwrap_or(0.0);
        connection
            .execute(
                "INSERT INTO scenarios (id, name, sort_key) VALUES (?1, ?2, ?3)",
                params![scenario.id, scenario.name, last + SORT_STEP],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rename_scenario(&self, scenario_id: &str, name: &str) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        self.connect()?
            .execute(
                "UPDATE scenarios SET name = ?2 WHERE id = ?1",
                params![scenario_id, name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_scenario(&self, scenario_id: &str) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute("DELETE FROM scenarios WHERE id = ?1", [scenario_id])
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "UPDATE metadata SET value = NULL
                 WHERE key = 'active_scenario_id' AND value = ?1",
                [scenario_id],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn insert_rule(
        &self,
        scenario_id: &str,
        rule: &Rule,
        after_rule_id: Option<&str>,
    ) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let connection = self.connect()?;
        let key = insertion_key(&connection, scenario_id, after_rule_id)?;
        insert_rule_connection(&connection, scenario_id, key, rule)
    }

    pub fn update_rule(&self, scenario_id: &str, rule: &Rule) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let connection = self.connect()?;
        let (kind, status, content_type, action_name) = action_columns(&rule.action);
        let json = serde_json::to_string(rule).map_err(|e| e.to_string())?;
        connection
            .execute(
                "UPDATE rules SET
                    enabled = ?3, fire_limit = ?4, repeat = ?5,
                    method = ?6, url = ?7, url_match = ?8, action_kind = ?9,
                    action_status = ?10, action_content_type = ?11,
                    action_name = ?12, rule_json = ?13
                 WHERE scenario_id = ?1 AND id = ?2",
                params![
                    scenario_id,
                    rule.id,
                    rule.enabled,
                    rule.fire_limit,
                    rule.repeat,
                    rule.matcher.method,
                    rule.matcher.url,
                    match_kind(&rule.matcher.url_match),
                    kind,
                    status,
                    content_type,
                    action_name,
                    json,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_rule(&self, scenario_id: &str, rule_id: &str) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        self.connect()?
            .execute(
                "DELETE FROM rules WHERE scenario_id = ?1 AND id = ?2",
                params![scenario_id, rule_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reorder_rule(
        &self,
        scenario_id: &str,
        rule_id: &str,
        previous_id: Option<&str>,
        next_id: Option<&str>,
    ) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        let previous = rule_sort_key(&transaction, scenario_id, previous_id)?;
        let next = rule_sort_key(&transaction, scenario_id, next_id)?;
        let key = match (previous, next) {
            (Some(previous), Some(next)) => {
                let midpoint = f64::midpoint(previous, next);
                // Repeated moves between the same neighbors exhaust f64
                // precision: once the midpoint collapses onto an endpoint, two
                // rows would share a sort_key and rule order (= match priority)
                // becomes nondeterministic. Resequence the scenario and retry.
                if midpoint > previous && midpoint < next {
                    midpoint
                } else {
                    resequence_sort_keys(&transaction, scenario_id)?;
                    let previous = rule_sort_key(&transaction, scenario_id, previous_id)?
                        .ok_or_else(|| "rule not found".to_string())?;
                    let next = rule_sort_key(&transaction, scenario_id, next_id)?
                        .ok_or_else(|| "rule not found".to_string())?;
                    f64::midpoint(previous, next)
                }
            }
            (Some(previous), None) => previous + SORT_STEP,
            (None, Some(next)) => next - SORT_STEP,
            (None, None) => 0.0,
        };
        transaction
            .execute(
                "UPDATE rules SET sort_key = ?3 WHERE scenario_id = ?1 AND id = ?2",
                params![scenario_id, rule_id, key],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn apply_mock_batch(
        &self,
        scenario_id: &str,
        scenario_name: &str,
        create_scenario: bool,
        rules: &[Rule],
    ) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        if create_scenario {
            let last = transaction
                .query_row("SELECT MAX(sort_key) FROM scenarios", [], |row| {
                    row.get::<_, Option<f64>>(0)
                })
                .map_err(|e| e.to_string())?
                .unwrap_or(0.0);
            transaction
                .execute(
                    "INSERT INTO scenarios (id, name, sort_key) VALUES (?1, ?2, ?3)",
                    params![scenario_id, scenario_name, last + SORT_STEP],
                )
                .map_err(|e| e.to_string())?;
        }
        let mut key = transaction
            .query_row(
                "SELECT MAX(sort_key) FROM rules WHERE scenario_id = ?1",
                [scenario_id],
                |row| row.get::<_, Option<f64>>(0),
            )
            .map_err(|e| e.to_string())?
            .unwrap_or(0.0);
        for rule in rules {
            key += SORT_STEP;
            insert_rule_row(&transaction, scenario_id, key, rule)?;
        }
        set_active_metadata(&transaction, Some(scenario_id))?;
        transaction.commit().map_err(|e| e.to_string())
    }
}

fn sort_key(index: usize) -> f64 {
    u32::try_from(index).map_or(f64::from(u32::MAX), f64::from) * SORT_STEP
}

fn set_active_metadata(
    transaction: &Transaction<'_>,
    scenario_id: Option<&str>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO metadata (key, value) VALUES ('active_scenario_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [scenario_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn set_general_metadata(transaction: &Transaction<'_>, active: bool) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO metadata (key, value) VALUES ('general_active', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if active { "1" } else { "0" }],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_rule_connection(
    connection: &Connection,
    scenario_id: &str,
    key: f64,
    rule: &Rule,
) -> Result<(), String> {
    let (kind, status, content_type, action_name) = action_columns(&rule.action);
    let json = serde_json::to_string(rule).map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO rules (
                id, scenario_id, sort_key, enabled, fire_limit, repeat,
                method, url, url_match, action_kind, action_status,
                action_content_type, action_name, rule_json
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
             )",
            params![
                rule.id,
                scenario_id,
                key,
                rule.enabled,
                rule.fire_limit,
                rule.repeat,
                rule.matcher.method,
                rule.matcher.url,
                match_kind(&rule.matcher.url_match),
                kind,
                status,
                content_type,
                action_name,
                json,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_rule_row(
    transaction: &Transaction<'_>,
    scenario_id: &str,
    key: f64,
    rule: &Rule,
) -> Result<(), String> {
    let (kind, status, content_type, action_name) = action_columns(&rule.action);
    let json = serde_json::to_string(rule).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT INTO rules (
                id, scenario_id, sort_key, enabled, fire_limit, repeat,
                method, url, url_match, action_kind, action_status,
                action_content_type, action_name, rule_json
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
             )",
            params![
                rule.id,
                scenario_id,
                key,
                rule.enabled,
                rule.fire_limit,
                rule.repeat,
                rule.matcher.method,
                rule.matcher.url,
                match_kind(&rule.matcher.url_match),
                kind,
                status,
                content_type,
                action_name,
                json,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insertion_key(
    connection: &Connection,
    scenario_id: &str,
    after_rule_id: Option<&str>,
) -> Result<f64, String> {
    let Some(after_rule_id) = after_rule_id else {
        return connection
            .query_row(
                "SELECT COALESCE(MAX(sort_key), 0) + ?2 FROM rules WHERE scenario_id = ?1",
                params![scenario_id, SORT_STEP],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string());
    };
    let after = rule_sort_key(connection, scenario_id, Some(after_rule_id))?
        .ok_or_else(|| "rule not found".to_string())?;
    let next = connection
        .query_row(
            "SELECT MIN(sort_key) FROM rules WHERE scenario_id = ?1 AND sort_key > ?2",
            params![scenario_id, after],
            |row| row.get::<_, Option<f64>>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(next.map_or(after + SORT_STEP, |next| f64::midpoint(after, next)))
}

fn resequence_sort_keys(connection: &Connection, scenario_id: &str) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT id FROM rules WHERE scenario_id = ?1 ORDER BY sort_key")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = statement
        .query_map([scenario_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        connection
            .execute(
                "UPDATE rules SET sort_key = ?3 WHERE scenario_id = ?1 AND id = ?2",
                params![scenario_id, id, sort_key(index)],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn rule_sort_key(
    connection: &Connection,
    scenario_id: &str,
    rule_id: Option<&str>,
) -> Result<Option<f64>, String> {
    let Some(rule_id) = rule_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT sort_key FROM rules WHERE scenario_id = ?1 AND id = ?2",
            params![scenario_id, rule_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn match_kind(kind: &MatchKind) -> &'static str {
    match kind {
        MatchKind::Contains => "contains",
        MatchKind::Exact => "exact",
        MatchKind::Regex => "regex",
    }
}

fn action_columns(action: &Action) -> (&'static str, Option<u16>, Option<&str>, Option<&str>) {
    match action {
        Action::Respond {
            status,
            content_type,
            ..
        } => ("respond", Some(*status), content_type.as_deref(), None),
        Action::MapLocal { status, .. } => ("mapLocal", Some(*status), None, None),
        Action::MapRemote { .. } => ("mapRemote", None, None, None),
        Action::Block => ("block", None, None, None),
        Action::SetRequestHeader { name, .. } => {
            ("setRequestHeader", None, None, Some(name.as_str()))
        }
        Action::SetResponseHeader { name, .. } => {
            ("setResponseHeader", None, None, Some(name.as_str()))
        }
        Action::SetStatus { status } => ("setStatus", Some(*status), None, None),
        Action::RewriteResponseBody { .. } => ("rewriteResponseBody", None, None, None),
        Action::Cors => ("cors", None, None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proxy_core::{Matcher, Rule};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("germi-rule-store-{name}-{nonce}"))
    }

    fn rule(id: &str, body: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: Some("GET".to_string()),
                url: format!("https://example.com/{id}"),
                url_match: MatchKind::Exact,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![("x-test".to_string(), id.to_string())],
                body: body.to_string(),
                content_type: Some("text/plain".to_string()),
                content_encoding: None,
            },
        }
    }

    fn autoresponder() -> AutoResponder {
        AutoResponder {
            scenarios: vec![Scenario {
                id: "scenario".to_string(),
                name: "Scenario".to_string(),
                rules: vec![rule("one", "first"), rule("two", "second"), rule("three", "third")],
            }],
            active_scenario_id: Some("scenario".to_string()),
            general_active: true,
        }
    }

    /// The first non-General scenario — `load()` always prepends the built-in
    /// General layer, so tests locate the user scenario by identity.
    fn user(ar: &AutoResponder) -> &Scenario {
        ar.scenarios
            .iter()
            .find(|s| s.id != GENERAL_SCENARIO_ID)
            .expect("a user scenario")
    }

    #[test]
    fn new_store_starts_empty() {
        let dir = test_dir("empty");
        let (store, loaded) = RuleStore::open(&dir, false).expect("open store");

        assert!(dir.join(DB_FILE).exists());
        assert_eq!(
            loaded.scenarios.len(),
            1,
            "a fresh store holds only the built-in General scenario"
        );
        assert_eq!(loaded.scenarios[0].id, GENERAL_SCENARIO_ID);
        assert!(loaded.scenarios[0].rules.is_empty());
        assert!(loaded.active_scenario_id.is_none());
        assert!(loaded.general_active, "General is on by default");

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn granular_update_and_reorder_preserve_other_rules() {
        let dir = test_dir("granular");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.replace(&autoresponder()).expect("seed store");

        let updated = rule("two", "updated");
        store
            .update_rule("scenario", &updated)
            .expect("update one rule");
        store
            .reorder_rule("scenario", "three", None, Some("one"))
            .expect("move rule to front");

        let loaded = store.load().expect("reload store");
        let rules = &user(&loaded).rules;
        assert_eq!(
            rules.iter().map(|rule| rule.id.as_str()).collect::<Vec<_>>(),
            vec!["three", "one", "two"]
        );
        assert!(matches!(
            &rules[2].action,
            Action::Respond { body, .. } if body == "updated"
        ));
        assert!(matches!(
            &rules[1].action,
            Action::Respond { body, .. } if body == "first"
        ));

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn map_remote_rule_round_trips() {
        let dir = test_dir("map-remote");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");

        let mut mapped = rule("map", "unused");
        mapped.matcher.url = r".*agent_(\w+)\.js".to_string();
        mapped.matcher.url_match = MatchKind::Regex;
        mapped.action = Action::MapRemote {
            url: "http://localhost:8080/ajax/agent_$1.js".to_string(),
        };
        let ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "scenario".to_string(),
                name: "Scenario".to_string(),
                rules: vec![mapped],
            }],
            active_scenario_id: Some("scenario".to_string()),
            general_active: true,
        };
        store.replace(&ar).expect("persist map-remote rule");

        let loaded = store.load().expect("reload store");
        assert!(matches!(
            &user(&loaded).rules[0].action,
            Action::MapRemote { url } if url == "http://localhost:8080/ajax/agent_$1.js"
        ));

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn two_rules_can_share_a_url() {
        // Issue #74: rules are keyed by id, not URL, so a scenario may hold
        // several rules with the same matcher URL. All must round-trip.
        let dir = test_dir("shared-url");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");

        let mut a = rule("a", "first");
        a.matcher.url = "https://example.com/dup".to_string();
        let mut b = rule("b", "second");
        b.matcher.url = "https://example.com/dup".to_string();
        let ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "scenario".to_string(),
                name: "Scenario".to_string(),
                rules: vec![a, b],
            }],
            active_scenario_id: Some("scenario".to_string()),
            general_active: true,
        };
        store.replace(&ar).expect("persist two same-url rules");

        let loaded = store.load().expect("reload store");
        let rules = &user(&loaded).rules;
        assert_eq!(
            rules.iter().map(|rule| rule.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(rules[0].matcher.url, rules[1].matcher.url);
        assert_eq!(rules[0].matcher.url, "https://example.com/dup");

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn read_only_store_never_persists_writes() {
        let dir = test_dir("read_only");
        // Seed via a writable handle (simulating the capturing instance).
        let (writer, _) = RuleStore::open(&dir, false).expect("open writer");
        writer.replace(&autoresponder()).expect("seed store");
        drop(writer);

        // A viewer (read_only) handle can load the seeded data...
        let (viewer, loaded) = RuleStore::open(&dir, true).expect("open viewer");
        assert_eq!(user(&loaded).rules.len(), 3);

        // ...but every mutation is a silent no-op that never touches disk.
        viewer
            .insert_scenario(&Scenario {
                id: "ghost".to_string(),
                name: "Ghost".to_string(),
                rules: Vec::new(),
            })
            .expect("insert is a no-op");
        viewer.delete_rule("scenario", "one").expect("delete is a no-op");
        viewer
            .update_rule("scenario", &rule("two", "hacked"))
            .expect("update is a no-op");
        viewer
            .replace(&AutoResponder {
                scenarios: Vec::new(),
                active_scenario_id: None,
                general_active: true,
            })
            .expect("replace is a no-op");

        // Reopen writable: the on-disk data is exactly what the writer seeded.
        let (_, after) = RuleStore::open(&dir, false).expect("reopen writer");
        assert_eq!(user(&after).id, "scenario");
        let ids: Vec<_> = user(&after).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two", "three"]);

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn open_rebuilds_a_legacy_schema_and_preserves_rules() {
        let dir = test_dir("legacy-schema");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);

        // Hand-build a pre-#74 database: `rules` carries a `name TEXT NOT NULL`
        // column the current code no longer writes, with a rule stored (as the
        // migrated real DBs are) via its full rule_json.
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE scenarios (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key REAL NOT NULL);
                 CREATE TABLE rules (
                    id TEXT PRIMARY KEY,
                    scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
                    sort_key REAL NOT NULL,
                    name TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    fire_limit INTEGER,
                    repeat INTEGER NOT NULL,
                    method TEXT,
                    url TEXT NOT NULL,
                    url_match TEXT NOT NULL,
                    action_kind TEXT NOT NULL,
                    action_status INTEGER,
                    action_content_type TEXT,
                    action_name TEXT,
                    rule_json TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO scenarios (id, name, sort_key) VALUES ('scenario', 'Scenario', 1024.0)",
                [],
            )
            .unwrap();
            let seeded = rule("one", "first");
            let json = serde_json::to_string(&seeded).unwrap();
            conn.execute(
                "INSERT INTO rules
                    (id, scenario_id, sort_key, name, enabled, repeat, url, url_match, action_kind, rule_json)
                 VALUES ('one', 'scenario', 1024.0, 'legacy name', 1, 0, ?1, 'exact', 'respond', ?2)",
                params![seeded.matcher.url, json],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO metadata (key, value) VALUES ('active_scenario_id', 'scenario')",
                [],
            )
            .unwrap();
        }

        // Opening writable heals the schema and preserves the rule.
        let (store, loaded) = RuleStore::open(&dir, false).expect("open heals stale schema");

        let cols: Vec<String> = {
            let conn = Connection::open(&db).unwrap();
            let mut stmt = conn.prepare("PRAGMA table_info(rules)").unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(1)).unwrap();
            rows.map(|c| c.unwrap()).collect()
        };
        assert!(
            !cols.iter().any(|c| c == "name"),
            "the legacy `name` column must be dropped: {cols:?}"
        );

        assert_eq!(user(&loaded).rules.len(), 1, "the rule is preserved via rule_json");
        assert_eq!(user(&loaded).rules[0].id, "one");
        assert_eq!(loaded.active_scenario_id.as_deref(), Some("scenario"));
        assert!(loaded.general().is_some(), "healing still yields the General layer");

        // The insert that used to fail on the dead constraint now succeeds.
        store
            .insert_rule("scenario", &rule("two", "second"), None)
            .expect("insert after heal");
        let reloaded = store.load().expect("reload");
        let ids: Vec<_> = user(&reloaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"two"), "a fresh rule inserts cleanly: {ids:?}");

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn open_leaves_a_current_schema_untouched() {
        // A DB already on the current schema must NOT be flagged stale (no needless
        // rebuild): seed it, reopen, and confirm the rules survive unchanged.
        let dir = test_dir("current-schema");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.replace(&autoresponder()).expect("seed store");
        drop(store);

        let (_, reloaded) = RuleStore::open(&dir, false).expect("reopen store");
        let ids: Vec<_> = user(&reloaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two", "three"]);

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn open_seeds_general_into_a_pre_feature_db() {
        // A DB written before the General layer existed: current schema, one user
        // scenario, and NO general scenario or general_active metadata. Opening it
        // must seed the General layer (defaulting on) without disturbing the user
        // scenario, and persist a durable General row.
        let dir = test_dir("pre-general");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.replace(&autoresponder()).expect("seed store");
        {
            // Simulate an older build: drop the General row + its metadata.
            let conn = Connection::open(dir.join(DB_FILE)).unwrap();
            conn.execute("DELETE FROM scenarios WHERE id = ?1", params![GENERAL_SCENARIO_ID])
                .unwrap();
            conn.execute("DELETE FROM metadata WHERE key = 'general_active'", [])
                .unwrap();
        }
        drop(store);

        let (store, loaded) = RuleStore::open(&dir, false).expect("reopen seeds General");
        assert_eq!(loaded.scenarios[0].id, GENERAL_SCENARIO_ID, "General seeded first");
        assert!(loaded.general_active, "absent metadata defaults the layer on");
        assert_eq!(user(&loaded).id, "scenario", "the user scenario is untouched");

        // A rule inserted into the seeded General scenario persists (its FK parent
        // row exists) and round-trips.
        store
            .insert_rule(GENERAL_SCENARIO_ID, &rule("g1", "cors"), None)
            .expect("insert into General");
        let reloaded = store.load().expect("reload");
        assert_eq!(
            reloaded.general().expect("General present").rules[0].id,
            "g1"
        );

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn failed_heal_keeps_the_original_database() {
        // A pre-#74 DB keyed rules by (scenario_id, id), so one rule id may
        // appear in two scenarios — data the current `id TEXT PRIMARY KEY`
        // rejects on re-insert. The heal must fail WITHOUT destroying the
        // original tables.
        let dir = test_dir("heal-rollback");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE scenarios (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key REAL NOT NULL);
                 CREATE TABLE rules (
                    id TEXT NOT NULL,
                    scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
                    sort_key REAL NOT NULL,
                    name TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    fire_limit INTEGER,
                    repeat INTEGER NOT NULL,
                    method TEXT,
                    url TEXT NOT NULL,
                    url_match TEXT NOT NULL,
                    action_kind TEXT NOT NULL,
                    action_status INTEGER,
                    action_content_type TEXT,
                    action_name TEXT,
                    rule_json TEXT NOT NULL,
                    PRIMARY KEY (scenario_id, id)
                 );",
            )
            .unwrap();
            for scenario in ["a", "b"] {
                conn.execute(
                    "INSERT INTO scenarios (id, name, sort_key) VALUES (?1, ?1, 1024.0)",
                    [scenario],
                )
                .unwrap();
                let seeded = rule("dup", "body");
                let json = serde_json::to_string(&seeded).unwrap();
                conn.execute(
                    "INSERT INTO rules
                        (id, scenario_id, sort_key, name, enabled, repeat, url, url_match, action_kind, rule_json)
                     VALUES ('dup', ?1, 1024.0, 'legacy', 1, 0, ?2, 'exact', 'respond', ?3)",
                    params![scenario, seeded.matcher.url, json],
                )
                .unwrap();
            }
        }

        let result = RuleStore::open(&dir, false);
        assert!(
            result.is_err(),
            "healing a DB whose preserved data violates the new schema must fail"
        );

        let conn = Connection::open(&db).unwrap();
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(rules)").unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(1)).unwrap();
            rows.map(|c| c.unwrap()).collect()
        };
        assert!(
            cols.iter().any(|c| c == "name"),
            "a failed heal must leave the original legacy table intact: {cols:?}"
        );
        let scenarios: i64 = conn
            .query_row("SELECT COUNT(*) FROM scenarios", [], |r| r.get(0))
            .unwrap();
        let rules_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rules", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            (scenarios, rules_count),
            (2, 2),
            "a failed heal must not lose any scenario or rule"
        );

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn heal_preserves_readable_rules_around_a_corrupt_row() {
        let dir = test_dir("heal-corrupt-row");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join(DB_FILE);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE scenarios (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_key REAL NOT NULL);
                 CREATE TABLE rules (
                    id TEXT PRIMARY KEY,
                    scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
                    sort_key REAL NOT NULL,
                    name TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    fire_limit INTEGER,
                    repeat INTEGER NOT NULL,
                    method TEXT,
                    url TEXT NOT NULL,
                    url_match TEXT NOT NULL,
                    action_kind TEXT NOT NULL,
                    action_status INTEGER,
                    action_content_type TEXT,
                    action_name TEXT,
                    rule_json TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO scenarios (id, name, sort_key) VALUES ('scenario', 'Scenario', 1024.0)",
                [],
            )
            .unwrap();
            for (index, (id, json)) in [
                ("one", serde_json::to_string(&rule("one", "first")).unwrap()),
                ("two", "not json".to_string()),
                ("three", serde_json::to_string(&rule("three", "third")).unwrap()),
            ]
            .into_iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO rules
                        (id, scenario_id, sort_key, name, enabled, repeat, url, url_match, action_kind, rule_json)
                     VALUES (?1, 'scenario', ?2, 'legacy', 1, 0, 'https://example.com', 'exact', 'respond', ?3)",
                    params![id, sort_key(index + 1), json],
                )
                .unwrap();
            }
        }

        let (_, loaded) = RuleStore::open(&dir, false).expect("heal salvages readable rows");
        let ids: Vec<_> = user(&loaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["one", "three"],
            "a heal must discard only the corrupt row, not everything"
        );

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn open_skips_an_undeserializable_rule_on_a_current_schema() {
        // Downgrade scenario: a newer build wrote a rule with an unknown Action
        // variant. Opening must not abort app launch — it skips that rule.
        let dir = test_dir("bad-rule-json");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.replace(&autoresponder()).expect("seed store");
        drop(store);
        {
            let conn = Connection::open(dir.join(DB_FILE)).unwrap();
            conn.execute(
                r#"UPDATE rules SET rule_json =
                   '{"id":"two","matcher":{"url":"https://example.com/two","urlMatch":"exact"},"action":{"kind":"fromTheFuture"}}'
                   WHERE id = 'two'"#,
                [],
            )
            .unwrap();
        }

        let (store, loaded) = RuleStore::open(&dir, false).expect("open tolerates one bad rule row");
        let ids: Vec<_> = user(&loaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "three"], "the good rules still load");

        let reloaded = store.load().expect("load tolerates one bad rule row");
        let ids: Vec<_> = user(&reloaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "three"]);

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn repeated_reorders_between_the_same_neighbors_keep_keys_distinct() {
        let dir = test_dir("reorder-precision");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.replace(&autoresponder()).expect("seed store");
        let conn = Connection::open(dir.join(DB_FILE)).unwrap();

        for round in 0..80 {
            if round % 2 == 0 {
                store
                    .reorder_rule("scenario", "one", Some("two"), Some("three"))
                    .expect("reorder one");
            } else {
                store
                    .reorder_rule("scenario", "three", Some("two"), Some("one"))
                    .expect("reorder three");
            }
            let keys: Vec<f64> = {
                let mut stmt = conn
                    .prepare("SELECT sort_key FROM rules WHERE scenario_id = 'scenario' ORDER BY sort_key")
                    .unwrap();
                let rows = stmt.query_map([], |row| row.get(0)).unwrap();
                rows.map(|k| k.unwrap()).collect()
            };
            assert!(
                keys[0] < keys[1] && keys[1] < keys[2],
                "sort keys must stay strictly distinct at round {round}: {keys:?}"
            );
        }

        let loaded = store.load().expect("reload");
        let ids: Vec<_> = user(&loaded).rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["two", "three", "one"], "order stays correct after 80 reorders");

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn general_active_toggle_round_trips() {
        let dir = test_dir("general-toggle");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        store.set_general_active(false).expect("toggle off");
        drop(store);

        let (_, loaded) = RuleStore::open(&dir, false).expect("reopen");
        assert!(!loaded.general_active, "the off toggle persists across reopen");

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }
}
