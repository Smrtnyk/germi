//! Rule tester — simulate the rule pipeline against a sample request without
//! touching the network. This is the "preview before you enable it" workflow:
//! paste a request, see exactly which rules match, whether one short-circuits,
//! and what response the client would receive.
//!
//! The function is pure (`&RuleSet`, `&TestInput` -> `TestResult`) so it is
//! trivially unit-tested and reused by the Tauri command unchanged.

use serde::{Deserialize, Serialize};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse};
use crate::rules::{RequestOutcome, RuleSet};

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
        None => (scheme, rest, "/".to_string()),
    }
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

    match rules.evaluate_request(&req) {
        RequestOutcome::Respond { rule, response } => TestResult {
            matched_rules,
            outcome: "respond".to_string(),
            short_circuit: true,
            fired_rule: Some(rule.clone()),
            effective_request_headers: req.headers,
            response: Some(TestResponse {
                status: response.status,
                headers: response.headers,
                body: String::from_utf8_lossy(&response.body).into_owned(),
                source: format!("Synthesized by rule \u{201c}{rule}\u{201d} — request never hit the network"),
            }),
            notes,
        },
        RequestOutcome::Block { rule } => TestResult {
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
        },
        RequestOutcome::Continue { set_headers } => {
            let mut eff = req.headers.clone();
            for (k, v) in &set_headers {
                if let Some(slot) = eff.iter_mut().find(|(hk, _)| hk.eq_ignore_ascii_case(k)) {
                    slot.1 = v.clone();
                } else {
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
            let fired = rules.apply_response(&req, &mut resp);
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
                    headers: resp.headers,
                    body: String::from_utf8_lossy(&resp.body).into_owned(),
                    source,
                }),
                notes,
            }
        }
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
}
