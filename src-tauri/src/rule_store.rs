//! Normalized `SQLite` persistence for autoresponder scenarios and rules.
//!
//! The frontend and common mutations never rewrite a monolithic JSON document:
//! scenario metadata, rule ordering and each full rule payload are stored in
//! separate rows. Summary columns keep list metadata queryable without parsing
//! response bodies.

use std::path::{Path, PathBuf};

use proxy_core::{Action, AutoResponder, MatchKind, Rule, Scenario};
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
        let connection = store.connect()?;
        Self::create_schema(&connection)?;
        let autoresponder = Self::load_with_connection(&connection)?;
        Ok((store, autoresponder))
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
                rules.push(serde_json::from_str(&json).map_err(|e| e.to_string())?);
            }
            scenarios.push(Scenario { id, name, rules });
        }

        Ok(AutoResponder {
            scenarios,
            active_scenario_id,
        })
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
                    &transaction,
                    &scenario.id,
                    sort_key(rule_index),
                    rule,
                )?;
            }
        }
        set_active_metadata(&transaction, autoresponder.active_scenario_id.as_deref())?;
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
        let connection = self.connect()?;
        let previous = rule_sort_key(&connection, scenario_id, previous_id)?;
        let next = rule_sort_key(&connection, scenario_id, next_id)?;
        let key = match (previous, next) {
            (Some(previous), Some(next)) => (previous + next) / 2.0,
            (Some(previous), None) => previous + SORT_STEP,
            (None, Some(next)) => next - SORT_STEP,
            (None, None) => 0.0,
        };
        connection
            .execute(
                "UPDATE rules SET sort_key = ?3 WHERE scenario_id = ?1 AND id = ?2",
                params![scenario_id, rule_id, key],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
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
    Ok(next.map_or(after + SORT_STEP, |next| (after + next) / 2.0))
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
        Action::Block => ("block", None, None, None),
        Action::SetRequestHeader { name, .. } => {
            ("setRequestHeader", None, None, Some(name.as_str()))
        }
        Action::SetResponseHeader { name, .. } => {
            ("setResponseHeader", None, None, Some(name.as_str()))
        }
        Action::SetStatus { status } => ("setStatus", Some(*status), None, None),
        Action::RewriteResponseBody { .. } => ("rewriteResponseBody", None, None, None),
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
        }
    }

    #[test]
    fn new_store_starts_empty() {
        let dir = test_dir("empty");
        let (store, loaded) = RuleStore::open(&dir, false).expect("open store");

        assert!(dir.join(DB_FILE).exists());
        assert!(loaded.scenarios.is_empty());
        assert!(loaded.active_scenario_id.is_none());

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
        let rules = &loaded.scenarios[0].rules;
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
        };
        store.replace(&ar).expect("persist two same-url rules");

        let loaded = store.load().expect("reload store");
        let rules = &loaded.scenarios[0].rules;
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
        assert_eq!(loaded.scenarios[0].rules.len(), 3);

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
            })
            .expect("replace is a no-op");

        // Reopen writable: the on-disk data is exactly what the writer seeded.
        let (_, after) = RuleStore::open(&dir, false).expect("reopen writer");
        assert_eq!(after.scenarios.len(), 1);
        assert_eq!(after.scenarios[0].id, "scenario");
        let ids: Vec<_> = after.scenarios[0].rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two", "three"]);

        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }
}
