//! Rule tester — simulate the rule pipeline against a sample request without
//! touching the network. This is the "preview before you enable it" workflow:
//! paste a request, see exactly which rules match, whether one short-circuits,
//! and what response the client would receive.
//!
//! The function is pure (`&RuleSet`, `&TestInput` -> `TestResult`) so it is
//! trivially unit-tested and reused by the Tauri command unchanged.

use serde::{Deserialize, Serialize};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse};
use crate::rules::{
    evaluate_request_rules_stateful, RequestOutcome, RuleCursors, RuleSet,
};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestInput {
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub req_headers: Vec<(String, String)>,
    #[serde(default)]
    pub req_body: String,
    /// Sample upstream response used to preview response-phase rules.
    #[serde(default = "default_status")]
    pub resp_status: u16,
    #[serde(default)]
    pub resp_headers: Vec<(String, String)>,
    #[serde(default)]
    pub resp_body: String,
}

fn default_method() -> String {
    "GET".to_string()
}
fn default_status() -> u16 {
    200
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Human-readable explanation of where this response came from.
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SequenceStep {
    pub outcome: String,
    pub status: Option<u16>,
    pub rule: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    /// Names of every enabled rule whose matcher matches the request.
    pub matched_rules: Vec<String>,
    /// "respond" | "block" | "continue".
    pub outcome: String,
    pub short_circuit: bool,
    /// The single rule that actually produced the outcome, if any.
    pub fired_rule: Option<String>,
    /// Request headers as forwarded upstream (only meaningful when continuing).
    pub effective_request_headers: Vec<(String, String)>,
    /// The response the client would receive.
    pub response: Option<TestResponse>,
    pub notes: Vec<String>,
    pub sequence: Vec<SequenceStep>,
    pub sequence_loops: bool,
}

/// Split a URL/pattern into `(scheme, host, path)`, matching how the live
/// pipeline reconstructs `scheme://host/path` for matching.
pub fn parse_url(url: &str) -> (String, String, String) {
    let (scheme, rest) = match url.find("://") {
        Some(i) => (url[..i].to_string(), url[i + 3..].to_string()),
        None => ("https".to_string(), url.to_string()),
    };
    if rest.is_empty() {
        return (scheme, String::new(), "/".to_string());
    }
    if rest.starts_with('/') {
        return (scheme, String::new(), rest);
    }
    match rest.find('/') {
        Some(i) => (scheme, rest[..i].to_string(), rest[i..].to_string()),
        // No path but a query (e.g. `host?x=1`): the query belongs to the path
        // (the live URI parser yields `/?x=1`), not the host.
        None => match rest.find('?') {
            Some(i) => (scheme, rest[..i].to_string(), format!("/{}", &rest[i..])),
            None => (scheme, rest, "/".to_string()),
        },
    }
}

/// Headers the live pipeline (`handler::build_parts`) strips before sending to
/// the client — content-length / transfer-encoding are recomputed by hyper from
/// the (possibly rewritten) body. Mirror that here so the preview matches what
/// the client actually receives.
fn client_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(k, _)| {
            !k.eq_ignore_ascii_case("content-length")
                && !k.eq_ignore_ascii_case("transfer-encoding")
        })
        .collect()
}

const PREVIEW_CAP: usize = 10;

fn preview_sequence(rules: &RuleSet, req: &CapturedRequest) -> (Vec<SequenceStep>, bool) {
    let mut cursors = RuleCursors::default();
    let mut steps = Vec::new();
    let mut ran_to_cap = true;
    for _ in 0..PREVIEW_CAP {
        let outcome = evaluate_request_rules_stateful(&rules.rules, req, &mut cursors);
        // Resolve the fired rule by id (names are not unique), so terminal
        // detection (unlimited rule = steady state) matches the rule that fired.
        let is_terminal_rule = |id: &str| {
            rules
                .rules
                .iter()
                .find(|r| r.id == id)
                .is_none_or(|r| r.fire_limit.is_none())
        };
        let terminal = match &outcome {
            RequestOutcome::Respond {
                rule,
                rule_id,
                response,
            } => {
                steps.push(SequenceStep {
                    outcome: "respond".into(),
                    status: Some(response.status),
                    rule: Some(rule.clone()),
                });
                is_terminal_rule(rule_id)
            }
            RequestOutcome::Block { rule, rule_id } => {
                steps.push(SequenceStep {
                    outcome: "block".into(),
                    status: Some(403),
                    rule: Some(rule.clone()),
                });
                is_terminal_rule(rule_id)
            }
            RequestOutcome::Continue { .. } => {
                steps.push(SequenceStep {
                    outcome: "continue".into(),
                    status: None,
                    rule: None,
                });
                true
            }
        };
        if terminal {
            ran_to_cap = false;
            break;
        }
    }
    let loops = ran_to_cap
        && rules
            .rules
            .iter()
            .any(|r| r.enabled && r.repeat && r.matcher.matches(req));
    (steps, loops)
}

pub fn test_rules(rules: &RuleSet, input: &TestInput) -> TestResult {
    let (scheme, host, path) = parse_url(&input.url);
    let req = CapturedRequest {
        method: input.method.clone(),
        uri: format!("{scheme}://{host}{path}"),
        scheme,
        host,
        path,
        version: "HTTP/1.1".to_string(),
        headers: input.req_headers.clone(),
        body: input.req_body.clone().into_bytes(),
        timestamp_ms: now_ms(),
    };

    let matched_rules: Vec<String> = rules
        .rules
        .iter()
        .filter(|r| r.enabled && r.matcher.matches(&req))
        .map(|r| r.name.clone())
        .collect();

    let mut notes = Vec::new();
    if matched_rules.is_empty() {
        notes.push(
            "No enabled rule matches this request — it passes through untouched.".to_string(),
        );
    }

    let (seq, sequence_loops) = preview_sequence(rules, &req);
    let sequence = if seq.len() > 1 { seq } else { Vec::new() };

    match rules.evaluate_request(&req) {
        RequestOutcome::Respond { rule, response, .. } => TestResult {
            matched_rules,
            outcome: "respond".to_string(),
            short_circuit: true,
            fired_rule: Some(rule.clone()),
            effective_request_headers: req.headers,
            response: Some(TestResponse {
                status: response.status,
                headers: client_headers(response.headers),
                body: String::from_utf8_lossy(&response.body).into_owned(),
                source: format!("Synthesized by rule \u{201c}{rule}\u{201d} — request never hit the network"),
            }),
            notes,
            sequence,
            sequence_loops,
        },
        RequestOutcome::Block { rule, .. } => TestResult {
            matched_rules,
            outcome: "block".to_string(),
            short_circuit: true,
            fired_rule: Some(rule.clone()),
            effective_request_headers: req.headers,
            response: Some(TestResponse {
                status: 403,
                headers: vec![("content-type".to_string(), "text/plain".to_string())],
                body: "Blocked by Germi".to_string(),
                source: format!("Blocked by rule \u{201c}{rule}\u{201d}"),
            }),
            notes,
            sequence,
            sequence_loops,
        },
        RequestOutcome::Continue { set_headers } => continue_result(
            rules,
            input,
            &req,
            &set_headers,
            matched_rules,
            notes,
            sequence,
            sequence_loops,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn continue_result(
    rules: &RuleSet,
    input: &TestInput,
    req: &CapturedRequest,
    set_headers: &[(String, String)],
    matched_rules: Vec<String>,
    mut notes: Vec<String>,
    sequence: Vec<SequenceStep>,
    sequence_loops: bool,
) -> TestResult {
    let mut eff = req.headers.clone();
    for (k, v) in set_headers {
        // Match the live engine (hyper `HeaderMap::insert`): replace the first
        // occurrence and drop any duplicates, collapsing to a single value.
        let mut replaced = false;
        eff.retain_mut(|(hk, hv)| {
            if hk.eq_ignore_ascii_case(k) {
                if replaced {
                    return false;
                }
                replaced = true;
                hv.clone_from(v);
            }
            true
        });
        if !replaced {
            eff.push((k.clone(), v.clone()));
        }
    }
    if !set_headers.is_empty() {
        notes.push(format!(
            "{} request-header rule(s) applied; request forwarded upstream.",
            set_headers.len()
        ));
    }

    let mut resp = CapturedResponse {
        status: input.resp_status,
        version: "HTTP/1.1".to_string(),
        headers: input.resp_headers.clone(),
        body: input.resp_body.clone().into_bytes(),
        timestamp_ms: now_ms(),
    };
    let fired = rules.apply_response(req, &mut resp);
    let source = match &fired {
        Some(name) => {
            format!("Sample upstream response, modified by rule \u{201c}{name}\u{201d}")
        }
        None => "Sample upstream response (no response-phase rule changed it)".to_string(),
    };

    TestResult {
        matched_rules,
        outcome: "continue".to_string(),
        short_circuit: false,
        fired_rule: fired,
        effective_request_headers: eff,
        response: Some(TestResponse {
            status: resp.status,
            headers: client_headers(resp.headers),
            body: String::from_utf8_lossy(&resp.body).into_owned(),
            source,
        }),
        notes,
        sequence,
        sequence_loops,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{Action, MatchKind, Matcher, Rule};

    fn respond_rule() -> Rule {
        Rule {
            id: "1".into(),
            name: "mock health".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: Some("GET".into()),
                url: "/health".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: "{\"ok\":true}".into(),
                content_type: Some("application/json".into()),
            },
        }
    }

    #[test]
    fn parses_url_forms() {
        assert_eq!(
            parse_url("https://example.com/api/x"),
            ("https".into(), "example.com".into(), "/api/x".into())
        );
        assert_eq!(
            parse_url("/api/x"),
            ("https".into(), String::new(), "/api/x".into())
        );
        assert_eq!(
            parse_url("example.com"),
            ("https".into(), "example.com".into(), "/".into())
        );
    }

    #[test]
    fn previews_auto_respond() {
        let rules = RuleSet {
            rules: vec![respond_rule()],
        };
        let input = TestInput {
            method: "GET".into(),
            url: "https://api.test/health".into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 200,
            resp_headers: vec![],
            resp_body: String::new(),
        };
        let result = test_rules(&rules, &input);
        assert_eq!(result.outcome, "respond");
        assert!(result.short_circuit);
        assert_eq!(result.fired_rule.as_deref(), Some("mock health"));
        let resp = result.response.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "{\"ok\":true}");
        assert!(resp.headers.iter().any(|(k, _)| k == "content-type"));
    }

    #[test]
    fn previews_response_rewrite_on_continue() {
        let rules = RuleSet {
            rules: vec![Rule {
                id: "2".into(),
                name: "redact".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher::default(),
                action: Action::RewriteResponseBody {
                    find: "secret".into(),
                    replace: "•••".into(),
                    regex: false,
                },
            }],
        };
        let input = TestInput {
            method: "GET".into(),
            url: "https://api.test/data".into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 200,
            resp_headers: vec![("content-type".into(), "text/plain".into())],
            resp_body: "the secret is here".into(),
        };
        let result = test_rules(&rules, &input);
        assert_eq!(result.outcome, "continue");
        assert!(!result.short_circuit);
        assert_eq!(result.response.unwrap().body, "the \u{2022}\u{2022}\u{2022} is here");
    }

    #[test]
    fn preview_strips_length_and_encoding_headers() {
        // A Respond rule that (against advice) hand-adds content-length /
        // transfer-encoding: the preview must not show them, matching the live
        // pipeline which recomputes/strips those.
        let rules = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                name: "mock".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher::default(),
                action: Action::Respond {
                    status: 200,
                    headers: vec![
                        ("Content-Length".into(), "999".into()),
                        ("Transfer-Encoding".into(), "chunked".into()),
                        ("X-Keep".into(), "yes".into()),
                    ],
                    body: "hi".into(),
                    content_type: None,
                },
            }],
        };
        let input = TestInput {
            method: "GET".into(),
            url: "https://api.test/x".into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 200,
            resp_headers: vec![],
            resp_body: String::new(),
        };
        let resp = test_rules(&rules, &input).response.unwrap();
        assert!(resp
            .headers
            .iter()
            .all(|(k, _)| !k.eq_ignore_ascii_case("content-length")
                && !k.eq_ignore_ascii_case("transfer-encoding")));
        assert!(resp.headers.iter().any(|(k, _)| k == "X-Keep"));
    }

    #[test]
    fn no_match_passes_through() {
        let rules = RuleSet {
            rules: vec![respond_rule()],
        };
        let input = TestInput {
            method: "GET".into(),
            url: "https://api.test/other".into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 204,
            resp_headers: vec![],
            resp_body: String::new(),
        };
        let result = test_rules(&rules, &input);
        assert_eq!(result.outcome, "continue");
        assert!(result.matched_rules.is_empty());
        assert_eq!(result.response.unwrap().status, 204);
    }

    fn seq_rule(id: &str, status: u16, fire_limit: Option<u32>, repeat: bool) -> Rule {
        Rule {
            id: id.into(),
            name: id.into(),
            enabled: true,
            fire_limit,
            repeat,
            matcher: Matcher {
                method: None,
                url: "/seq".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status,
                headers: vec![],
                body: format!("body-{id}"),
                content_type: None,
            },
        }
    }

    fn seq_input() -> TestInput {
        TestInput {
            method: "GET".into(),
            url: "https://api.test/seq".into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 200,
            resp_headers: vec![],
            resp_body: String::new(),
        }
    }

    #[test]
    fn sequence_preview_advances() {
        let rules = RuleSet {
            rules: vec![
                seq_rule("A", 201, Some(1), false),
                seq_rule("B", 202, Some(1), false),
            ],
        };
        let result = test_rules(&rules, &seq_input());
        assert_eq!(result.sequence.len(), 3);
        assert_eq!(result.sequence[0].outcome, "respond");
        assert_eq!(result.sequence[1].outcome, "respond");
        assert_eq!(result.sequence[2].outcome, "continue");
        assert_eq!(
            result
                .sequence
                .iter()
                .map(|s| s.status)
                .collect::<Vec<_>>(),
            vec![Some(201), Some(202), None]
        );
        assert!(!result.sequence_loops);
    }

    #[test]
    fn sequence_preview_status_503_200() {
        let rules = RuleSet {
            rules: vec![
                seq_rule("A", 503, Some(2), false),
                seq_rule("B", 200, None, false),
            ],
        };
        let result = test_rules(&rules, &seq_input());
        assert_eq!(
            result
                .sequence
                .iter()
                .map(|s| s.status)
                .collect::<Vec<_>>(),
            vec![Some(503), Some(503), Some(200)]
        );
        assert_eq!(result.sequence.len(), 3);
        assert!(!result.sequence_loops);
    }

    #[test]
    fn sequence_preview_loops_flagged() {
        let rules = RuleSet {
            rules: vec![
                seq_rule("A", 201, Some(1), true),
                seq_rule("B", 202, Some(1), true),
            ],
        };
        let result = test_rules(&rules, &seq_input());
        assert!(result.sequence_loops);
        assert_eq!(result.sequence.len(), PREVIEW_CAP);
    }

    #[test]
    fn sequence_empty_for_single_static_rule() {
        let rules = RuleSet {
            rules: vec![seq_rule("A", 200, None, false)],
        };
        let result = test_rules(&rules, &seq_input());
        assert!(result.sequence.is_empty());
        assert_eq!(result.outcome, "respond");
        assert!(result.response.is_some());
    }
}
