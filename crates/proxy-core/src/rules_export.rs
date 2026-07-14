//! Portable import/export of autoresponder scenarios. The on-disk carrier is a
//! HAR (see `har_export`): a rules export is a HAR with zero entries whose
//! `_germiRules` field holds the [`RulesExport`] bundle, so traffic and rules
//! share one standard format. [`parse_rules`] also still accepts the legacy
//! bare `.germi-rules` bundle, so files written before the unification keep
//! importing. This is *config sharing* — distinct from the internal `SQLite`
//! persistence.
//!
//! Imported scenarios are always re-keyed: every scenario and every rule gets a
//! fresh id. Cursor accounting ([`crate::rules::RuleCursors`]) is rule-id keyed,
//! so re-keying guarantees an imported copy can never alias an existing rule's
//! hit counter (or collide with another scenario inside the same file).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::flow::now_ms;
use crate::rules::Scenario;

const FORMAT_VERSION: u32 = 1;

/// Process-wide so re-keyed ids stay unique across separate imports — including
/// two imports landing in the same millisecond (`base`), which would otherwise
/// collide and re-alias the cursor accounting that re-keying exists to protect.
static IMPORT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RulesExport {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub scenarios: Vec<Scenario>,
}

impl RulesExport {
    /// A bundle of `scenarios` stamped with the current format version — the
    /// shape carried in a HAR's `_germiRules` extension field (see
    /// `har_export`), and formerly written bare as a `.germi-rules` file.
    pub fn new(scenarios: Vec<Scenario>) -> Self {
        RulesExport {
            version: FORMAT_VERSION,
            scenarios,
        }
    }
}

/// One scenario of an embedded rules bundle, summarized for the import prompt
/// ("this HAR carries N scenarios") before anything is applied.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioPreview {
    pub name: String,
    pub rule_count: usize,
}

/// Summarize a rules bundle without importing (or re-keying) anything. Returns
/// `None` when the bytes aren't a usable bundle — malformed, a newer format
/// version, or carrying no scenarios — so callers simply don't offer an import.
pub fn preview_rules(bytes: &[u8]) -> Option<Vec<ScenarioPreview>> {
    let export: RulesExport = serde_json::from_slice(bytes).ok()?;
    if export.version > FORMAT_VERSION || export.scenarios.is_empty() {
        return None;
    }
    Some(
        export
            .scenarios
            .iter()
            .map(|s| ScenarioPreview {
                name: s.name.clone(),
                rule_count: s.rules.len(),
            })
            .collect(),
    )
}

/// Just the version field, read first so a newer-format file gets a clear
/// "unsupported version" message instead of a confusing deserialization error
/// when its (changed) shape no longer fits the current `RulesExport`.
#[derive(Deserialize)]
struct VersionPeek {
    #[serde(default)]
    version: u32,
}

/// Parse a rules file, returning its scenarios already re-keyed with fresh
/// scenario + rule ids. Accepts a HAR carrying `_germiRules` (the current
/// export shape) or a legacy bare `.germi-rules` bundle; a HAR *without* the
/// field is rejected with a clear message rather than silently importing
/// nothing. The HAR check must come first — fed to the bare parser, a HAR
/// would "succeed" as an empty bundle (every field is defaulted).
pub fn parse_rules(bytes: &[u8]) -> Result<Vec<Scenario>> {
    if let Some(bundle) = crate::import::har_embedded_rules(bytes) {
        return parse_bundle(&bundle);
    }
    if is_har(bytes) {
        anyhow::bail!("this HAR carries no embedded mock rules (embedding is opted into on save)");
    }
    parse_bundle(bytes)
}

/// Whether the bytes are a HAR-shaped JSON document (a top-level `log` object).
fn is_har(bytes: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Peek {
        log: Option<serde::de::IgnoredAny>,
    }
    serde_json::from_slice::<Peek>(bytes).is_ok_and(|p| p.log.is_some())
}

/// Parse a bare [`RulesExport`] bundle, re-keying every scenario and rule.
/// Rejects a bundle from a newer, incompatible format.
fn parse_bundle(bytes: &[u8]) -> Result<Vec<Scenario>> {
    if let Ok(peek) = serde_json::from_slice::<VersionPeek>(bytes) {
        if peek.version > FORMAT_VERSION {
            anyhow::bail!(
                "unsupported rules-bundle version {} (this build supports up to {})",
                peek.version,
                FORMAT_VERSION
            );
        }
    }
    let export: RulesExport = serde_json::from_slice(bytes)?;
    if export.version > FORMAT_VERSION {
        anyhow::bail!(
            "unsupported rules-bundle version {} (this build supports up to {})",
            export.version,
            FORMAT_VERSION
        );
    }
    let base = now_ms();
    Ok(export
        .scenarios
        .into_iter()
        .map(|s| rekey_scenario(s, base))
        .collect())
}

/// Assign a fresh scenario id and a fresh id to every rule. All other fields are
/// preserved verbatim. Ids draw from a process-wide counter, so they stay unique
/// across separate imports — not merely within a single one.
fn rekey_scenario(mut scenario: Scenario, base: u64) -> Scenario {
    scenario.id = new_id(base);
    for rule in &mut scenario.rules {
        rule.id = new_id(base);
    }
    scenario
}

fn new_id(base: u64) -> String {
    let n = IMPORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("imported-{base}-{n}")
}

/// Return a name not present in `taken`, suffixing `(2)`, `(3)`, … on collision,
/// and record the chosen name in `taken`.
pub fn dedupe_name(taken: &mut HashSet<String>, name: &str) -> String {
    if !taken.contains(name) {
        taken.insert(name.to_string());
        return name.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{name} ({n})");
        if !taken.contains(&candidate) {
            taken.insert(candidate.clone());
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{Action, MatchKind, Matcher, Rule};

    /// The legacy bare `.germi-rules` file shape. Production code no longer
    /// writes it (exports are rules-only HARs), but pre-unification files
    /// exist, so the tests keep producing it to cover the import fallback.
    fn export_rules(scenarios: &[Scenario]) -> Vec<u8> {
        serde_json::to_vec_pretty(&RulesExport::new(scenarios.to_vec()))
            .expect("serialize legacy bundle")
    }

    fn respond_rule(id: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: Some(3),
            repeat: true,
            matcher: Matcher {
                method: Some("GET".to_string()),
                url: "/api/x".to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 201,
                headers: vec![("x-test".to_string(), "1".to_string())],
                body: "{\"a\":1}".to_string(),
                body_base64: None,
                content_type: Some("application/json".to_string()),
                content_encoding: None,
            },
        }
    }

    fn scenario(id: &str, name: &str, rules: Vec<Rule>) -> Scenario {
        Scenario {
            id: id.to_string(),
            name: name.to_string(),
            rules,
        }
    }

    fn all_ids(scenarios: &[Scenario]) -> Vec<String> {
        let mut ids = Vec::new();
        for s in scenarios {
            ids.push(s.id.clone());
            ids.extend(s.rules.iter().map(|r| r.id.clone()));
        }
        ids
    }

    #[test]
    fn export_then_parse_round_trips() {
        let scenarios = vec![
            scenario("sc-1", "First", vec![respond_rule("r-1")]),
            scenario(
                "sc-2",
                "Second",
                vec![
                    Rule {
                        action: Action::Block,
                        ..respond_rule("r-2")
                    },
                    Rule {
                        action: Action::RewriteResponseBody {
                            find: "a".to_string(),
                            replace: "b".to_string(),
                            regex: true,
                        },
                        ..respond_rule("r-3")
                    },
                ],
            ),
        ];
        let bytes = export_rules(&scenarios);
        let back = parse_rules(&bytes).expect("parse round-trip");

        assert_eq!(back.len(), 2);
        assert_eq!(back[0].name, "First");
        assert_eq!(back[1].name, "Second");
        assert_eq!(back[0].rules.len(), 1);
        assert_eq!(back[1].rules.len(), 2);

        // Action fields survive verbatim (camelCase mirror + enum tag).
        match &back[0].rules[0].action {
            Action::Respond {
                status,
                body,
                content_type,
                headers,
                content_encoding,
                ..
            } => {
                assert_eq!(*status, 201);
                assert_eq!(body, "{\"a\":1}");
                assert_eq!(content_type.as_deref(), Some("application/json"));
                assert_eq!(headers, &vec![("x-test".to_string(), "1".to_string())]);
                assert_eq!(
                    *content_encoding, None,
                    "identity toggle round-trips as None"
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }
        assert_eq!(back[0].rules[0].matcher.url, "/api/x");
        assert_eq!(back[0].rules[0].fire_limit, Some(3));
        assert!(back[0].rules[0].repeat);
        assert!(matches!(back[1].rules[0].action, Action::Block));
        assert!(matches!(
            back[1].rules[1].action,
            Action::RewriteResponseBody { regex: true, .. }
        ));
    }

    #[test]
    fn parse_assigns_fresh_ids() {
        let scenarios = vec![
            scenario("sc-1", "A", vec![respond_rule("r-1"), respond_rule("r-2")]),
            scenario("sc-2", "B", vec![respond_rule("r-3"), respond_rule("r-4")]),
        ];
        let original = all_ids(&scenarios);
        let bytes = export_rules(&scenarios);
        let back = parse_rules(&bytes).expect("parse");

        let fresh = all_ids(&back);
        for id in &original {
            assert!(
                !fresh.contains(id),
                "id {id} from the source must be replaced on import"
            );
        }
        // Every assigned id is unique (the same-millisecond multi-scenario case).
        let unique: HashSet<&String> = fresh.iter().collect();
        assert_eq!(unique.len(), fresh.len(), "all imported ids must be unique");
    }

    #[test]
    fn parse_rejects_newer_version() {
        let err = parse_rules(br#"{"version":2,"scenarios":[]}"#).unwrap_err();
        assert!(err.to_string().contains("unsupported"));
        assert!(parse_rules(br#"{"version":1,"scenarios":[]}"#).is_ok());
        assert!(parse_rules(br#"{"version":0,"scenarios":[]}"#).is_ok());
        // A file with no version key defaults to 0 and still parses.
        assert!(parse_rules(br#"{"scenarios":[]}"#).is_ok());
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(parse_rules(b"not json").is_err());
        assert!(parse_rules(b"{").is_err());
    }

    #[test]
    fn parse_empty_scenarios_ok() {
        let back = parse_rules(br#"{"version":1,"scenarios":[]}"#).expect("parse empty");
        assert!(back.is_empty());
    }

    #[test]
    fn dedupe_name_suffixes_on_collision() {
        let mut taken: HashSet<String> = HashSet::new();
        taken.insert("My mocks".to_string());

        assert_eq!(dedupe_name(&mut taken, "My mocks"), "My mocks (2)");
        assert_eq!(dedupe_name(&mut taken, "My mocks"), "My mocks (3)");
        assert_eq!(dedupe_name(&mut taken, "Fresh"), "Fresh");
        // The fresh name was recorded, so a repeat now suffixes too.
        assert_eq!(dedupe_name(&mut taken, "Fresh"), "Fresh (2)");
    }

    #[test]
    fn dedupe_name_skips_preexisting_suffix_slot() {
        let mut taken: HashSet<String> = HashSet::new();
        taken.insert("A".to_string());
        taken.insert("A (2)".to_string());
        assert_eq!(
            dedupe_name(&mut taken, "A"),
            "A (3)",
            "an already-occupied (2) slot must be skipped, not clobbered"
        );
    }

    fn one_rule_scenario(action: Action) -> Scenario {
        scenario(
            "sc",
            "S",
            vec![Rule {
                action,
                ..respond_rule("r")
            }],
        )
    }

    #[test]
    fn round_trip_preserves_every_action_variant() {
        let scenarios = vec![
            one_rule_scenario(Action::Respond {
                status: 418,
                headers: vec![("x-a".into(), "1".into()), ("x-b".into(), "2".into())],
                body: "teapot".into(),
                body_base64: None,
                content_type: Some("text/plain".into()),
                content_encoding: None,
            }),
            one_rule_scenario(Action::MapLocal {
                path: "/tmp/some/file.json".into(),
                status: 206,
            }),
            one_rule_scenario(Action::Block),
            one_rule_scenario(Action::SetRequestHeader {
                name: "x-req".into(),
                value: "req-val".into(),
            }),
            one_rule_scenario(Action::SetResponseHeader {
                name: "x-resp".into(),
                value: "resp-val".into(),
            }),
            one_rule_scenario(Action::SetStatus { status: 503 }),
            one_rule_scenario(Action::RewriteResponseBody {
                find: "secret".into(),
                replace: "public".into(),
                regex: false,
            }),
        ];
        let back = parse_rules(&export_rules(&scenarios)).expect("round-trip");
        assert_eq!(back.len(), 7);

        assert!(matches!(
            &back[0].rules[0].action,
            Action::Respond { status: 418, body, content_type, headers, content_encoding: None, .. }
                if body == "teapot"
                    && content_type.as_deref() == Some("text/plain")
                    && headers.len() == 2
        ));
        assert!(matches!(
            &back[1].rules[0].action,
            Action::MapLocal { path, status: 206 } if path == "/tmp/some/file.json"
        ));
        assert!(matches!(back[2].rules[0].action, Action::Block));
        assert!(matches!(
            &back[3].rules[0].action,
            Action::SetRequestHeader { name, value } if name == "x-req" && value == "req-val"
        ));
        assert!(matches!(
            &back[4].rules[0].action,
            Action::SetResponseHeader { name, value } if name == "x-resp" && value == "resp-val"
        ));
        assert!(matches!(
            back[5].rules[0].action,
            Action::SetStatus { status: 503 }
        ));
        assert!(matches!(
            &back[6].rules[0].action,
            Action::RewriteResponseBody { find, replace, regex: false }
                if find == "secret" && replace == "public"
        ));
    }

    #[test]
    fn round_trip_preserves_rule_metadata_and_matcher() {
        let mut rule = respond_rule("r");
        rule.enabled = false;
        rule.fire_limit = None;
        rule.repeat = false;
        rule.matcher = Matcher {
            method: Some("DELETE".into()),
            url: r"^https://api\.test/v\d+/".into(),
            url_match: MatchKind::Regex,
        };
        let back =
            parse_rules(&export_rules(&[scenario("sc", "S", vec![rule])])).expect("round-trip");
        let r = &back[0].rules[0];
        assert!(
            !r.enabled,
            "a disabled rule must stay disabled across export/import"
        );
        assert_eq!(r.fire_limit, None);
        assert!(!r.repeat);
        assert_eq!(r.matcher.method.as_deref(), Some("DELETE"));
        assert_eq!(r.matcher.url, r"^https://api\.test/v\d+/");
        assert_eq!(r.matcher.url_match, MatchKind::Regex);
    }

    #[test]
    fn round_trip_preserves_content_encoding_toggle() {
        // A Respond rule that opts into gzip on the wire must keep that toggle
        // across export/import, and the field must serialize as camelCase
        // (`contentEncoding`) so the TS mirror matches.
        let scenarios = vec![one_rule_scenario(Action::Respond {
            status: 200,
            headers: vec![],
            body: "{\"ok\":true}".into(),
            body_base64: None,
            content_type: Some("application/json".into()),
            content_encoding: Some("gzip".into()),
        })];
        let json = String::from_utf8(export_rules(&scenarios)).expect("utf8 json");
        assert!(
            json.contains("\"contentEncoding\": \"gzip\""),
            "content_encoding must serialize as camelCase contentEncoding, got: {json}"
        );
        let back = parse_rules(&export_rules(&scenarios)).expect("round-trip");
        assert!(matches!(
            &back[0].rules[0].action,
            Action::Respond { content_encoding, .. } if content_encoding.as_deref() == Some("gzip")
        ));
    }

    #[test]
    fn parse_tolerates_respond_rule_without_content_encoding() {
        // A hand-authored / older bundle that omits contentEncoding must still
        // parse via serde default (identity toggle), so existing .germi-rules
        // files keep working after the field is added.
        let bytes = br#"{
            "version": 1,
            "scenarios": [{
                "id": "s", "name": "S",
                "rules": [{
                    "id": "r", "name": "r",
                    "matcher": { "url": "/x" },
                    "action": { "kind": "respond", "status": 200, "body": "hi" }
                }]
            }]
        }"#;
        let back = parse_rules(bytes).expect("older bundle parses via serde default");
        assert!(matches!(
            &back[0].rules[0].action,
            Action::Respond {
                content_encoding: None,
                ..
            }
        ));
    }

    #[test]
    fn binary_respond_body_round_trips_with_legacy_text_preview() {
        let scenarios = vec![one_rule_scenario(Action::Respond {
            status: 200,
            headers: vec![],
            body: "� preview".into(),
            body_base64: Some("AP/+gA==".into()),
            content_type: Some("application/octet-stream".into()),
            content_encoding: None,
        })];
        let parsed = parse_rules(&export_rules(&scenarios)).expect("round trip");
        assert!(matches!(
            &parsed[0].rules[0].action,
            Action::Respond { body_base64: Some(encoded), .. } if encoded == "AP/+gA=="
        ));
    }

    #[test]
    fn exported_bytes_use_camelcase_and_kind_tag() {
        let scenarios = vec![one_rule_scenario(Action::RewriteResponseBody {
            find: "a".into(),
            replace: "b".into(),
            regex: true,
        })];
        let json = String::from_utf8(export_rules(&scenarios)).expect("utf8 json");

        assert!(
            json.contains("\"version\""),
            "bundle carries a version field"
        );
        assert!(
            json.contains("\"fireLimit\""),
            "snake_case rule fields must serialize as camelCase (fireLimit)"
        );
        assert!(
            json.contains("\"urlMatch\""),
            "matcher.url_match must serialize as camelCase (urlMatch)"
        );
        assert!(
            json.contains("\"kind\": \"rewriteResponseBody\""),
            "the Action enum is internally tagged with a camelCase `kind`"
        );
        assert!(
            !json.contains("activeScenarioId"),
            "the export format must never carry the active-scenario pointer"
        );
    }

    #[test]
    fn parse_tolerates_minimal_handwritten_rule() {
        // A hand-authored bundle relying on serde defaults: no version, rule omits
        // enabled/fireLimit/repeat, matcher omits method/url_match.
        let bytes = br#"{
            "scenarios": [
                {
                    "id": "hand",
                    "name": "Hand",
                    "rules": [
                        {
                            "id": "hr",
                            "name": "Hand rule",
                            "matcher": { "url": "/x" },
                            "action": { "kind": "block" }
                        }
                    ]
                }
            ]
        }"#;
        let back = parse_rules(bytes).expect("minimal bundle parses via serde defaults");
        assert_eq!(back.len(), 1);
        let r = &back[0].rules[0];
        assert!(r.enabled, "enabled defaults to true");
        assert_eq!(r.fire_limit, None);
        assert!(!r.repeat);
        assert_eq!(r.matcher.method, None);
        assert_eq!(r.matcher.url_match, MatchKind::Contains);
        assert!(matches!(r.action, Action::Block));
        assert_ne!(
            r.id, "hr",
            "even a hand-authored rule id is re-keyed on import"
        );
    }

    #[test]
    fn two_parses_of_same_bytes_do_not_share_ids() {
        let scenarios = vec![
            scenario("sc-1", "A", vec![respond_rule("r-1"), respond_rule("r-2")]),
            scenario("sc-2", "B", vec![respond_rule("r-3")]),
        ];
        let bytes = export_rules(&scenarios);
        let first = parse_rules(&bytes).expect("first parse");
        let second = parse_rules(&bytes).expect("second parse");

        let mut combined: Vec<String> = all_ids(&first);
        combined.extend(all_ids(&second));
        let unique: HashSet<&String> = combined.iter().collect();
        assert_eq!(
            unique.len(),
            combined.len(),
            "re-parsing the same bytes (same-millisecond double import) must still yield globally unique ids"
        );
    }

    #[test]
    fn preview_summarizes_without_importing() {
        let scenarios = vec![
            scenario("sc-1", "A", vec![respond_rule("r-1"), respond_rule("r-2")]),
            scenario("sc-2", "B", vec![]),
        ];
        let previews = preview_rules(&export_rules(&scenarios)).expect("preview");
        assert_eq!(previews.len(), 2);
        assert_eq!(previews[0].name, "A");
        assert_eq!(previews[0].rule_count, 2);
        assert_eq!(previews[1].rule_count, 0);
    }

    #[test]
    fn preview_rejects_unusable_bundles() {
        let newer = br#"{"version":99,"scenarios":[{"id":"a","name":"N","rules":[]}]}"#;
        assert!(
            preview_rules(newer).is_none(),
            "newer format is not offered"
        );
        assert!(
            preview_rules(br#"{"version":1,"scenarios":[]}"#).is_none(),
            "nothing to import"
        );
        assert!(preview_rules(b"junk").is_none());
    }

    #[test]
    fn parses_rules_from_a_rules_only_har() {
        let scenarios = vec![scenario("sc-1", "Shared", vec![respond_rule("r-1")])];
        let har = crate::har_export::export_har(&[], Some(&scenarios));
        let back = parse_rules(&har).expect("rules HAR parses");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "Shared");
        assert_eq!(back[0].rules.len(), 1);
        assert_ne!(back[0].id, "sc-1", "HAR-carried scenarios are re-keyed too");
    }

    #[test]
    fn empty_selection_round_trips_through_a_rules_only_har() {
        let har = crate::har_export::export_har(&[], Some(&[]));
        assert_eq!(parse_rules(&har).expect("empty bundle parses").len(), 0);
    }

    #[test]
    fn har_without_embedded_rules_is_rejected_not_empty() {
        let err = parse_rules(br#"{"log":{"entries":[]}}"#).unwrap_err();
        assert!(
            err.to_string().contains("no embedded mock rules"),
            "a plain traffic HAR must fail loudly, not import zero scenarios: {err}"
        );
    }
}
