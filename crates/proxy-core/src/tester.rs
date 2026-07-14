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
    apply_request_header_edits, apply_response_rules, blocked_response, evaluate_request_rules,
    evaluate_request_rules_stateful, has_request_repeat_cycle, valid_header, RequestOutcome, Rule,
    RuleCursors, RuleSet, SyntheticResponse,
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
    /// "respond" | "block" | "continue" | "mapRemote".
    pub outcome: String,
    pub short_circuit: bool,
    /// The single rule that actually produced the outcome, if any.
    pub fired_rule: Option<String>,
    /// Request headers after request-phase rules, including before a synthetic
    /// response whose response rules can inspect the effective request.
    pub effective_request_headers: Vec<(String, String)>,
    /// The response the client would receive.
    pub response: Option<TestResponse>,
    pub notes: Vec<String>,
    pub sequence: Vec<SequenceStep>,
    pub sequence_loops: bool,
    /// Where a Map Remote rule forwards the request (capture groups expanded).
    pub mapped_url: Option<String>,
}

/// Split a URL/pattern into `(scheme, host, path)`, matching how the live
/// pipeline reconstructs `scheme://host/path` for matching.
pub fn parse_url(url: &str) -> (String, String, String) {
    let (scheme, rest) = match url.find("://") {
        Some(i) => (url[..i].to_ascii_lowercase(), &url[i + 3..]),
        None => ("https".to_string(), url),
    };
    if rest.is_empty() {
        return (scheme, String::new(), "/".to_string());
    }
    if rest.starts_with('/') {
        let path = rest.split_once('#').map_or(rest, |(path, _)| path);
        return (scheme, String::new(), path.to_string());
    }
    let authority_end = rest
        .char_indices()
        .find_map(|(index, ch)| matches!(ch, '/' | '?' | '#').then_some(index))
        .unwrap_or(rest.len());
    // Userinfo is not part of the live request host. Keep the authority text
    // otherwise (including an explicit default port) so tester/import matching
    // agrees with captures rather than URL-normalizing it away.
    let authority = &rest[..authority_end];
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_string();
    let suffix = &rest[authority_end..];
    let path_and_query = suffix.split_once('#').map_or(suffix, |(path, _)| path);
    let path = if path_and_query.is_empty() {
        "/".to_string()
    } else if path_and_query.starts_with('?') {
        format!("/{path_and_query}")
    } else {
        path_and_query.to_string()
    };
    (scheme, host, path)
}

/// Framing declarations the live pipeline removes before rebuilding a fixed or
/// bodyless response. The tester exposes logical headers rather than inventing
/// hyper's wire framing, but must never retain a stale trailer declaration.
fn client_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(k, v)| {
            valid_header(k, v)
                && !k.eq_ignore_ascii_case("content-length")
                && !k.eq_ignore_ascii_case("transfer-encoding")
                && !k.eq_ignore_ascii_case("trailer")
        })
        .collect()
}

const PREVIEW_CAP: usize = 10;

fn wire_status(status: u16) -> u16 {
    if (100..=999).contains(&status) {
        status
    } else {
        200
    }
}

fn preview_sequence(rules: &[Rule], req: &CapturedRequest) -> (Vec<SequenceStep>, bool) {
    let mut cursors = RuleCursors::default();
    let mut steps = Vec::new();
    let mut ran_to_cap = true;
    for _ in 0..PREVIEW_CAP {
        let outcome = evaluate_request_rules_stateful(rules, req, &mut cursors);
        // Resolve the fired rule by id (names are not unique), so terminal
        // detection (unlimited rule = steady state) matches the rule that fired.
        let is_terminal_rule = |id: &str| {
            rules
                .iter()
                .find(|r| r.id == id)
                .is_none_or(|r| r.fire_limit.is_none())
        };
        let terminal = match &outcome {
            RequestOutcome::Respond {
                rule,
                rule_id,
                response,
                ..
            } => {
                steps.push(SequenceStep {
                    outcome: "respond".into(),
                    status: Some(wire_status(response.status)),
                    rule: Some(rule.clone()),
                });
                is_terminal_rule(rule_id)
            }
            RequestOutcome::Block { rule, rule_id, .. } => {
                steps.push(SequenceStep {
                    outcome: "block".into(),
                    status: Some(403),
                    rule: Some(rule.clone()),
                });
                is_terminal_rule(rule_id)
            }
            RequestOutcome::MapRemote { rule, rule_id, .. } => {
                steps.push(SequenceStep {
                    outcome: "mapRemote".into(),
                    status: None,
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
                !has_request_repeat_cycle(rules, req)
            }
        };
        if terminal {
            ran_to_cap = false;
            break;
        }
    }
    let loops = ran_to_cap && has_request_repeat_cycle(rules, req);
    (steps, loops)
}

pub fn test_rules(rules: &RuleSet, input: &TestInput) -> TestResult {
    test_rule_slice(&rules.rules, input)
}

fn captured_test_request(input: &TestInput) -> CapturedRequest {
    let (scheme, host, path) = parse_url(&input.url);
    CapturedRequest {
        method: input.method.clone(),
        uri: format!("{scheme}://{host}{path}"),
        scheme,
        host,
        path,
        version: "HTTP/1.1".to_string(),
        headers: input.req_headers.clone(),
        body: input.req_body.clone().into(),
        timestamp_ms: now_ms(),
    }
}

fn matched_rule_labels(rules: &[Rule], req: &CapturedRequest) -> Vec<String> {
    rules
        .iter()
        .filter(|rule| rule.enabled && rule.matcher.matches(req))
        .map(Rule::label)
        .collect()
}

fn initial_notes(matched_rules: &[String]) -> Vec<String> {
    if matched_rules.is_empty() {
        vec!["No enabled rule matches this request — it passes through untouched.".to_string()]
    } else {
        Vec::new()
    }
}

pub(crate) fn test_rule_slice(rules: &[Rule], input: &TestInput) -> TestResult {
    let req = captured_test_request(input);
    let matched_rules = matched_rule_labels(rules, &req);
    let mut notes = initial_notes(&matched_rules);

    let (seq, sequence_loops) = preview_sequence(rules, &req);
    let sequence = if seq.len() > 1 { seq } else { Vec::new() };

    match evaluate_request_rules(rules, &req) {
        RequestOutcome::Respond {
            rule,
            response,
            set_headers,
            ..
        } => {
            let effective_request = request_with_headers(&req, &set_headers);
            let (resp, modified) = finalized_synthetic(rules, &effective_request, response);
            let base = format!("Synthesized by rule \u{201c}{rule}\u{201d}");
            TestResult {
                matched_rules,
                outcome: "respond".to_string(),
                short_circuit: true,
                fired_rule: Some(rule),
                effective_request_headers: effective_request.headers,
                response: Some(preview_response(
                    &input.method,
                    resp.status,
                    resp.headers,
                    resp.body,
                    format!(
                        "{} — request never hit the network",
                        modified_source(base, modified)
                    ),
                )),
                notes,
                sequence,
                sequence_loops,
                mapped_url: None,
            }
        }
        RequestOutcome::Block {
            rule, set_headers, ..
        } => {
            let effective_request = request_with_headers(&req, &set_headers);
            let (resp, modified) =
                finalized_synthetic(rules, &effective_request, blocked_response());
            let base = format!("Blocked by rule \u{201c}{rule}\u{201d}");
            TestResult {
                matched_rules,
                outcome: "block".to_string(),
                short_circuit: true,
                fired_rule: Some(rule),
                effective_request_headers: effective_request.headers,
                response: Some(preview_response(
                    &input.method,
                    resp.status,
                    resp.headers,
                    resp.body,
                    modified_source(base, modified),
                )),
                notes,
                sequence,
                sequence_loops,
                mapped_url: None,
            }
        }
        RequestOutcome::MapRemote {
            rule,
            url,
            set_headers,
            ..
        } => {
            notes.push(format!(
                "Rule \u{201c}{rule}\u{201d} forwards this request to {url} — the response below is the sample upstream response."
            ));
            let base = continue_result(
                rules,
                input,
                &req,
                &set_headers,
                matched_rules,
                notes,
                sequence,
                sequence_loops,
            );
            map_remote_result(base, rule, url)
        }
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

/// Rebrand a `continue` preview as a Map Remote one — the tester has no
/// network, so the mapped target's real response can't be fetched; the sample
/// upstream response stands in, and the rule + expanded target are surfaced.
fn map_remote_result(mut base: TestResult, rule: String, url: String) -> TestResult {
    base.outcome = "mapRemote".to_string();
    base.fired_rule = Some(rule);
    base.mapped_url = Some(url);
    base
}

/// Run the response-phase rules over a rule-synthesized response, mirroring the
/// live pipeline (`CaptureHandler::finalize_synthetic`) so the preview matches
/// what the client receives. Side-effect-free: fire budgets are not consumed.
fn finalized_synthetic(
    rules: &[Rule],
    req: &CapturedRequest,
    synthetic: SyntheticResponse,
) -> (CapturedResponse, Option<String>) {
    let mut resp = CapturedResponse {
        status: synthetic.status,
        version: "HTTP/1.1".to_string(),
        headers: synthetic.headers,
        body: synthetic.body,
        timestamp_ms: now_ms(),
    };
    let modified = apply_response_rules(rules, req, &mut resp);
    (resp, modified)
}

fn modified_source(base: String, modified: Option<String>) -> String {
    match modified {
        Some(name) => format!("{base}, modified by rule \u{201c}{name}\u{201d}"),
        None => base,
    }
}

fn request_with_headers(
    req: &CapturedRequest,
    set_headers: &[(String, String)],
) -> CapturedRequest {
    let mut effective = req.clone();
    apply_request_header_edits(&mut effective.headers, set_headers);
    effective
}

#[allow(clippy::too_many_arguments)]
fn continue_result(
    rules: &[Rule],
    input: &TestInput,
    req: &CapturedRequest,
    set_headers: &[(String, String)],
    matched_rules: Vec<String>,
    mut notes: Vec<String>,
    sequence: Vec<SequenceStep>,
    sequence_loops: bool,
) -> TestResult {
    let effective_request = request_with_headers(req, set_headers);
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
        body: input.resp_body.clone().into(),
        timestamp_ms: now_ms(),
    };
    let fired = apply_response_rules(rules, &effective_request, &mut resp);
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
        effective_request_headers: effective_request.headers,
        response: Some(preview_response(
            &input.method,
            resp.status,
            resp.headers,
            resp.body,
            source,
        )),
        notes,
        sequence,
        sequence_loops,
        mapped_url: None,
    }
}

/// Build the preview [`TestResponse`] the tester shows for "what the client
/// receives". The wire body may be Content-Encoded (a `Respond` rule with a
/// `content_encoding` toggle, or an encoded sample upstream response); for the
/// preview we decode it back to readable text (best-effort, falling back to a
/// lossy string) so the user sees the *content*, while keeping the
/// `content-encoding` header visible to signal the wire is compressed.
/// content-length / transfer-encoding / trailer are stripped to match the live
/// pipeline's framing normalization. HEAD and status-defined bodyless responses
/// display no body, even when the sample or rule supplied representation bytes.
fn preview_response(
    method: &str,
    status: u16,
    headers: Vec<(String, String)>,
    body: bytes::Bytes,
    source: String,
) -> TestResponse {
    let status = wire_status(status);
    let display_body = if method.eq_ignore_ascii_case("HEAD")
        || (100..200).contains(&status)
        || matches!(status, 204 | 205 | 304)
    {
        String::new()
    } else {
        match crate::body::decode_body(&headers, &body) {
            Some((decoded, false)) => String::from_utf8_lossy(&decoded).into_owned(),
            _ => String::from_utf8_lossy(&body).into_owned(),
        }
    };
    TestResponse {
        status,
        headers: client_headers(headers),
        body: display_body,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{Action, MatchKind, Matcher, Rule};

    fn respond_rule() -> Rule {
        Rule {
            id: "1".into(),
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
                body_base64: None,
                content_type: Some("application/json".into()),
                content_encoding: None,
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
        assert_eq!(
            parse_url("http://localhost:3000/api?x=1"),
            ("http".into(), "localhost:3000".into(), "/api?x=1".into())
        );
        assert_eq!(
            parse_url("localhost:8080"),
            ("https".into(), "localhost:8080".into(), "/".into())
        );
        assert_eq!(
            parse_url("host:8080?q=1"),
            ("https".into(), "host:8080".into(), "/?q=1".into())
        );
        // Bracketed IPv6 keeps both its literal form and explicit port.
        assert_eq!(parse_url("http://[::1]:8080/x").1, "[::1]:8080".to_string());
        assert_eq!(parse_url("http://[::1]/x").1, "[::1]".to_string());
        assert_eq!(
            parse_url("HTTPS://alice:secret@example.com:443/api?q=1#private"),
            ("https".into(), "example.com:443".into(), "/api?q=1".into())
        );
        assert_eq!(
            parse_url("https://example.com?x=1#ignored"),
            ("https".into(), "example.com".into(), "/?x=1".into())
        );
        assert_eq!(
            parse_url("/api?q=1#ignored"),
            ("https".into(), String::new(), "/api?q=1".into())
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
        assert_eq!(result.fired_rule.as_deref(), Some("/health"));
        assert_eq!(result.matched_rules, vec!["/health".to_string()]);
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
        assert_eq!(
            result.response.unwrap().body,
            "the \u{2022}\u{2022}\u{2022} is here"
        );
    }

    #[test]
    fn preview_strips_length_and_encoding_headers() {
        // A Respond rule that (against advice) hand-adds content-length /
        // transfer-encoding: the preview must not show them, matching the live
        // pipeline which recomputes/strips those.
        let rules = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher::default(),
                action: Action::Respond {
                    status: 200,
                    headers: vec![
                        ("Content-Length".into(), "999".into()),
                        ("Transfer-Encoding".into(), "chunked".into()),
                        ("Trailer".into(), "x-checksum".into()),
                        ("X-Keep".into(), "yes".into()),
                    ],
                    body: "hi".into(),
                    body_base64: None,
                    content_type: None,
                    content_encoding: None,
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
                && !k.eq_ignore_ascii_case("transfer-encoding")
                && !k.eq_ignore_ascii_case("trailer")));
        assert!(resp.headers.iter().any(|(k, _)| k == "X-Keep"));
    }

    #[test]
    fn preview_omits_bodies_the_live_http_response_cannot_send() {
        let rules = RuleSet::default();
        let mut input = get_input("https://api.test/data");
        input.method = "HEAD".into();
        input.resp_body = "representation metadata only".into();
        assert_eq!(test_rules(&rules, &input).response.unwrap().body, "");

        input.method = "GET".into();
        input.resp_status = 205;
        input.resp_body = "must be suppressed".into();
        assert_eq!(test_rules(&rules, &input).response.unwrap().body, "");
    }

    #[test]
    fn preview_sanitizes_invalid_rule_and_sample_statuses_like_the_live_handler() {
        let mut rule = respond_rule();
        let Action::Respond { status, .. } = &mut rule.action else {
            unreachable!()
        };
        *status = 0;
        let rules = RuleSet { rules: vec![rule] };
        let mut input = get_input("https://api.test/health");
        assert_eq!(test_rules(&rules, &input).response.unwrap().status, 200);

        input.url = "https://api.test/no-rule".into();
        input.resp_status = 0;
        assert_eq!(test_rules(&rules, &input).response.unwrap().status, 200);
    }

    #[test]
    fn preview_drops_invalid_mock_headers_like_the_live_handler() {
        let mut rule = respond_rule();
        let Action::Respond { headers, .. } = &mut rule.action else {
            unreachable!()
        };
        *headers = vec![
            ("bad header".into(), "value".into()),
            ("x-bad-value".into(), "line\nbreak".into()),
            ("x-keep".into(), "yes".into()),
        ];

        let response = test_rules(
            &RuleSet { rules: vec![rule] },
            &get_input("https://api.test/health"),
        )
        .response
        .unwrap();
        assert_eq!(
            response.headers,
            vec![
                ("x-keep".into(), "yes".into()),
                ("content-type".into(), "application/json".into()),
            ]
        );
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
                body_base64: None,
                content_type: None,
                content_encoding: None,
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
            result.sequence.iter().map(|s| s.status).collect::<Vec<_>>(),
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
            result.sequence.iter().map(|s| s.status).collect::<Vec<_>>(),
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
    fn sequence_preview_does_not_stop_at_a_transient_continue_inside_a_repeat_cycle() {
        let header = Rule {
            id: "header".into(),
            enabled: true,
            fire_limit: Some(2),
            repeat: true,
            matcher: Matcher {
                method: None,
                url: "/seq".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::SetRequestHeader {
                name: "x-cycle".into(),
                value: "yes".into(),
            },
        };
        let rules = RuleSet {
            rules: vec![header, seq_rule("mock", 201, Some(1), true)],
        };

        let result = test_rules(&rules, &seq_input());
        assert!(result.sequence_loops);
        assert_eq!(result.sequence.len(), PREVIEW_CAP);
        assert_eq!(result.sequence[0].outcome, "respond");
        assert_eq!(result.sequence[1].outcome, "continue");
        assert_eq!(result.sequence[2].outcome, "respond");
    }

    #[test]
    fn unavailable_or_zero_limit_repeat_rules_do_not_claim_a_loop() {
        let mut dead = seq_rule("dead", 201, Some(0), true);
        let rules = RuleSet {
            rules: vec![dead.clone()],
        };
        assert!(!test_rules(&rules, &seq_input()).sequence_loops);

        dead.fire_limit = Some(1);
        dead.action = Action::MapLocal {
            path: "/a/path/that/does/not/exist".into(),
            status: 200,
        };
        let rules = RuleSet { rules: vec![dead] };
        assert!(!test_rules(&rules, &seq_input()).sequence_loops);
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

    fn set_header_rule(name: &str, value: &str) -> Rule {
        Rule {
            id: "hdr".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::SetResponseHeader {
                name: name.into(),
                value: value.into(),
            },
        }
    }

    fn get_input(url: &str) -> TestInput {
        TestInput {
            method: "GET".into(),
            url: url.into(),
            req_headers: vec![],
            req_body: String::new(),
            resp_status: 200,
            resp_headers: vec![],
            resp_body: String::new(),
        }
    }

    #[test]
    fn response_rules_apply_to_mocked_responses() {
        let rules = RuleSet {
            rules: vec![respond_rule(), set_header_rule("x-injected", "yes")],
        };
        let result = test_rules(&rules, &get_input("https://api.test/health"));
        assert_eq!(result.outcome, "respond");
        let resp = result.response.unwrap();
        assert!(resp
            .headers
            .iter()
            .any(|(k, v)| k == "x-injected" && v == "yes"));
        assert!(resp.source.contains("modified by rule"));
        assert!(resp.source.contains("never hit the network"));
    }

    fn cors_rule() -> Rule {
        Rule {
            id: "c".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::Cors,
        }
    }

    #[test]
    fn previews_cors_stamp_on_mocked_response() {
        let rules = RuleSet {
            rules: vec![cors_rule(), respond_rule()],
        };
        let mut input = get_input("https://api.test/health");
        input.req_headers = vec![("origin".into(), "http://localhost:5173".into())];
        let result = test_rules(&rules, &input);
        assert_eq!(result.outcome, "respond");
        let resp = result.response.unwrap();
        assert!(resp
            .headers
            .iter()
            .any(|(k, v)| k == "access-control-allow-origin" && v == "http://localhost:5173"));
    }

    #[test]
    fn request_header_edits_reach_mock_response_rules() {
        let origin = Rule {
            id: "origin".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::SetRequestHeader {
                name: "origin".into(),
                value: "http://localhost:5173".into(),
            },
        };
        let rules = RuleSet {
            rules: vec![origin, respond_rule(), cors_rule()],
        };

        let result = test_rules(&rules, &get_input("https://api.test/health"));
        assert_eq!(result.outcome, "respond");
        assert!(result
            .effective_request_headers
            .iter()
            .any(|(k, v)| k == "origin" && v == "http://localhost:5173"));
        assert!(result
            .response
            .unwrap()
            .headers
            .iter()
            .any(|(k, v)| { k == "access-control-allow-origin" && v == "http://localhost:5173" }));
    }

    #[test]
    fn previews_cors_preflight_answer() {
        let rules = RuleSet {
            rules: vec![cors_rule()],
        };
        let mut input = get_input("https://api.test/health");
        input.method = "OPTIONS".into();
        input.req_headers = vec![
            ("origin".into(), "http://localhost:5173".into()),
            ("access-control-request-method".into(), "GET".into()),
        ];
        let result = test_rules(&rules, &input);
        assert_eq!(result.outcome, "respond");
        assert_eq!(result.response.unwrap().status, 204);
    }

    #[test]
    fn response_rules_apply_to_blocked_responses() {
        let block = Rule {
            id: "b".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/health".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Block,
        };
        let rules = RuleSet {
            rules: vec![block, set_header_rule("access-control-allow-origin", "*")],
        };
        let result = test_rules(&rules, &get_input("https://api.test/health"));
        assert_eq!(result.outcome, "block");
        let resp = result.response.unwrap();
        assert_eq!(resp.status, 403);
        assert!(resp
            .headers
            .iter()
            .any(|(k, v)| k == "access-control-allow-origin" && v == "*"));
    }

    #[test]
    fn previews_map_remote_with_expanded_target() {
        let rules = RuleSet {
            rules: vec![Rule {
                id: "map".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher {
                    method: None,
                    url: r".*agent_(\w+)\.js".into(),
                    url_match: MatchKind::Regex,
                },
                action: Action::MapRemote {
                    url: "http://localhost:8080/ajax/agent_$1.js".into(),
                },
            }],
        };
        let result = test_rules(&rules, &get_input("https://cdn.test/agent_abc.js"));
        assert_eq!(result.outcome, "mapRemote");
        assert!(!result.short_circuit, "the request still goes on the wire");
        assert_eq!(result.fired_rule.as_deref(), Some(r".*agent_(\w+)\.js"));
        assert_eq!(
            result.mapped_url.as_deref(),
            Some("http://localhost:8080/ajax/agent_abc.js")
        );
        // The preview response is the sample upstream one — the tester has no
        // network to fetch the mapped target.
        assert_eq!(result.response.unwrap().status, 200);
        assert!(result.notes.iter().any(|n| n.contains("localhost:8080")));
    }
}
