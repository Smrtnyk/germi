//! The rules engine — Germi's "sprinkles".
//!
//! Rules are grouped into [`Scenario`]s. The [`AutoResponder`] holds many
//! scenarios but only **one is active at a time** (or none — "Off"). The engine
//! evaluates just the active scenario's enabled rules, so you can keep several
//! mock setups around and switch between them instantly.
//!
//! Within a scenario, rules are evaluated in order; the first *short-circuiting*
//! action (Respond / MapLocal / Block) wins and the request never hits the
//! network. Non-short-circuiting actions (header/body/status edits) accumulate.
//! Request-phase actions run in `handle_request`; response-phase in
//! `handle_response`.

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::flow::{CapturedRequest, CapturedResponse, Flow};

/// How a [`Matcher`]'s `url` pattern is compared against a flow's URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// Case-sensitive substring match (default — the friendliest).
    Contains,
    /// Exact string equality.
    Exact,
    /// Rust regular expression.
    Regex,
}

impl Default for MatchKind {
    fn default() -> Self {
        MatchKind::Contains
    }
}

/// Scopes which flows a rule touches.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Matcher {
    /// HTTP method to require. `None`/empty matches any method.
    #[serde(default)]
    pub method: Option<String>,
    /// Pattern compared against the reconstructed URL `scheme://host/path`.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub url_match: MatchKind,
}

impl Matcher {
    pub fn matches(&self, req: &CapturedRequest) -> bool {
        if let Some(method) = &self.method {
            if !method.is_empty() && !method.eq_ignore_ascii_case(&req.method) {
                return false;
            }
        }
        let url = format!("{}://{}{}", req.scheme, req.host, req.path);
        match self.url_match {
            MatchKind::Contains => self.url.is_empty() || url.contains(&self.url),
            MatchKind::Exact => url == self.url,
            MatchKind::Regex => Regex::new(&self.url)
                .map(|re| re.is_match(&url))
                .unwrap_or(false),
        }
    }
}

/// What a rule does when it matches.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    // --- request-phase, short-circuiting ---
    /// Synthesize a full response and return it without hitting the network.
    Respond {
        status: u16,
        #[serde(default)]
        headers: Vec<(String, String)>,
        #[serde(default)]
        body: String,
        #[serde(default)]
        content_type: Option<String>,
    },
    /// Serve a local file as the response body (Fiddler "Map Local").
    MapLocal {
        path: String,
        #[serde(default = "default_ok")]
        status: u16,
    },
    /// Drop the request with a 403.
    Block,

    // --- request-phase, pass-through ---
    /// Add/replace a request header before forwarding upstream.
    SetRequestHeader { name: String, value: String },

    // --- response-phase ---
    /// Add/replace a response header.
    SetResponseHeader { name: String, value: String },
    /// Override the response status code.
    SetStatus { status: u16 },
    /// Find/replace in the response body (literal or regex).
    RewriteResponseBody {
        find: String,
        replace: String,
        #[serde(default)]
        regex: bool,
    },
}

fn default_ok() -> u16 {
    200
}

/// A single named rule.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub matcher: Matcher,
    pub action: Action,
}

fn default_true() -> bool {
    true
}

/// An ordered collection of rules (one scenario's worth, or the tester input).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RuleSet {
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// A named, switchable group of rules. Exactly one scenario is active at a time.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// The autoresponder: many scenarios, at most one active (`None` = Off).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoResponder {
    #[serde(default)]
    pub scenarios: Vec<Scenario>,
    /// Id of the active scenario, or `None` for Off (plain passthrough).
    #[serde(default)]
    pub active_scenario_id: Option<String>,
}

/// A response built entirely by a rule (no upstream request was made).
#[derive(Clone, Debug)]
pub struct SyntheticResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The decision produced by evaluating request-phase rules.
#[derive(Clone, Debug)]
pub enum RequestOutcome {
    /// Forward the request upstream, after applying these header edits.
    Continue { set_headers: Vec<(String, String)> },
    /// Short-circuit with a synthesized response. Carries the rule name.
    Respond {
        rule: String,
        response: SyntheticResponse,
    },
    /// Drop the request. Carries the rule name.
    Block { rule: String },
}

/// Evaluate request-phase rules in order (shared by RuleSet, Scenario, tester).
pub fn evaluate_request_rules(rules: &[Rule], req: &CapturedRequest) -> RequestOutcome {
    let mut set_headers = Vec::new();
    for rule in rules.iter().filter(|r| r.enabled) {
        if !rule.matcher.matches(req) {
            continue;
        }
        match &rule.action {
            Action::Respond {
                status,
                headers,
                body,
                content_type,
            } => {
                let mut hs = headers.clone();
                if let Some(ct) = content_type {
                    if !ct.is_empty() {
                        hs.push(("content-type".to_string(), ct.clone()));
                    }
                }
                return RequestOutcome::Respond {
                    rule: rule.name.clone(),
                    response: SyntheticResponse {
                        status: *status,
                        headers: hs,
                        body: body.clone().into_bytes(),
                    },
                };
            }
            Action::MapLocal { path, status } => match std::fs::read(path) {
                Ok(bytes) => {
                    let ct = mime_guess::from_path(path)
                        .first_raw()
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    return RequestOutcome::Respond {
                        rule: rule.name.clone(),
                        response: SyntheticResponse {
                            status: *status,
                            headers: vec![("content-type".to_string(), ct)],
                            body: bytes,
                        },
                    };
                }
                // Missing file: skip this rule rather than break the flow.
                Err(_) => continue,
            },
            Action::Block => {
                return RequestOutcome::Block {
                    rule: rule.name.clone(),
                }
            }
            Action::SetRequestHeader { name, value } => {
                set_headers.push((name.clone(), value.clone()));
            }
            // Response-phase actions are ignored here.
            Action::SetResponseHeader { .. }
            | Action::SetStatus { .. }
            | Action::RewriteResponseBody { .. } => {}
        }
    }
    RequestOutcome::Continue { set_headers }
}

/// Apply response-phase rules in order, mutating `resp`. Returns the last rule
/// that changed it, if any.
pub fn apply_response_rules(
    rules: &[Rule],
    req: &CapturedRequest,
    resp: &mut CapturedResponse,
) -> Option<String> {
    let mut matched = None;
    for rule in rules.iter().filter(|r| r.enabled) {
        if !rule.matcher.matches(req) {
            continue;
        }
        match &rule.action {
            Action::SetResponseHeader { name, value } => {
                set_header(&mut resp.headers, name, value);
                matched = Some(rule.name.clone());
            }
            Action::SetStatus { status } => {
                resp.status = *status;
                matched = Some(rule.name.clone());
            }
            Action::RewriteResponseBody {
                find,
                replace,
                regex,
            } => {
                if let Ok(text) = String::from_utf8(resp.body.clone()) {
                    let new = if *regex {
                        match Regex::new(find) {
                            Ok(re) => re.replace_all(&text, replace.as_str()).into_owned(),
                            Err(_) => text,
                        }
                    } else {
                        text.replace(find, replace)
                    };
                    resp.body = new.into_bytes();
                    matched = Some(rule.name.clone());
                }
            }
            _ => {}
        }
    }
    matched
}

impl RuleSet {
    pub fn evaluate_request(&self, req: &CapturedRequest) -> RequestOutcome {
        evaluate_request_rules(&self.rules, req)
    }

    pub fn apply_response(
        &self,
        req: &CapturedRequest,
        resp: &mut CapturedResponse,
    ) -> Option<String> {
        apply_response_rules(&self.rules, req, resp)
    }

    /// A starter rule (disabled) so the UI shows the shape of things.
    pub fn example() -> Self {
        RuleSet {
            rules: vec![Rule {
                id: "example-health".to_string(),
                name: "Mock GET /api/health".to_string(),
                enabled: true,
                matcher: Matcher {
                    method: Some("GET".to_string()),
                    url: "/api/health".to_string(),
                    url_match: MatchKind::Contains,
                },
                action: Action::Respond {
                    status: 200,
                    headers: vec![],
                    body: "{\"status\":\"ok\",\"mocked\":\"by germi\"}".to_string(),
                    content_type: Some("application/json".to_string()),
                },
            }],
        }
    }
}

impl AutoResponder {
    /// The active scenario, or `None` when Off.
    pub fn active(&self) -> Option<&Scenario> {
        match &self.active_scenario_id {
            Some(id) => self.scenarios.iter().find(|s| &s.id == id),
            None => None,
        }
    }

    pub fn evaluate_request(&self, req: &CapturedRequest) -> RequestOutcome {
        match self.active() {
            Some(s) => evaluate_request_rules(&s.rules, req),
            None => RequestOutcome::Continue {
                set_headers: vec![],
            },
        }
    }

    pub fn apply_response(
        &self,
        req: &CapturedRequest,
        resp: &mut CapturedResponse,
    ) -> Option<String> {
        match self.active() {
            Some(s) => apply_response_rules(&s.rules, req, resp),
            None => None,
        }
    }

    /// A starter autoresponder: one example scenario, Off by default.
    pub fn example() -> Self {
        AutoResponder {
            scenarios: vec![Scenario {
                id: "default".to_string(),
                name: "My mocks".to_string(),
                rules: RuleSet::example().rules,
            }],
            active_scenario_id: None,
        }
    }
}

/// Build a `Respond` rule seeded from a captured flow — matcher targets the same
/// method + path, action replays the captured response (status, content-type,
/// body). This is the "Mock this" / bulk "Add to scenario" seed.
pub fn respond_rule_from_flow(flow: &Flow, id: String) -> Rule {
    let (status, body, content_type, headers) = match &flow.response {
        Some(r) => {
            let ct = r
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone());
            // Seed the real response headers — minus content-type (its own field)
            // and length/encoding/hop-by-hop headers the engine recomputes.
            let headers: Vec<(String, String)> = r
                .headers
                .iter()
                .filter(|(k, _)| !is_seed_excluded(k))
                .cloned()
                .collect();
            (
                r.status,
                String::from_utf8_lossy(&r.body).into_owned(),
                ct,
                headers,
            )
        }
        None => (200, String::new(), None, Vec::new()),
    };

    // One rule per request, host-specific: the matcher targets the flow's full
    // URL (scheme://host/path+query) so mocking github.com/feed does NOT also
    // catch dynatrace.com/feed. Fiddler-style — nothing is collapsed. The name
    // includes the host so rules across hosts stay distinguishable; cap it (the
    // list middle-truncates).
    let full_url = format!(
        "{}://{}{}",
        flow.request.scheme, flow.request.host, flow.request.path
    );
    let mut name = format!("{} {}{}", flow.request.method, flow.request.host, flow.request.path);
    if name.chars().count() > 100 {
        name = name.chars().take(99).collect::<String>() + "\u{2026}";
    }

    Rule {
        id,
        name,
        enabled: true,
        matcher: Matcher {
            method: Some(flow.request.method.clone()),
            url: full_url,
            url_match: MatchKind::Contains,
        },
        action: Action::Respond {
            status,
            headers,
            body,
            content_type,
        },
    }
}

/// Headers that should NOT be copied into a seeded mock — either they have a
/// dedicated field (content-type) or they're length/encoding/hop-by-hop headers
/// the engine recomputes.
fn is_seed_excluded(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-type"
            | "content-length"
            | "content-encoding"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

/// Insert or replace a header (case-insensitive on the name).
fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if let Some(slot) = headers.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
        slot.1 = value.to_string();
    } else {
        headers.push((name.to_string(), value.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, scheme: &str, host: &str, path: &str) -> CapturedRequest {
        CapturedRequest {
            method: method.to_string(),
            uri: format!("{scheme}://{host}{path}"),
            scheme: scheme.to_string(),
            host: host.to_string(),
            path: path.to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![],
            body: vec![],
            timestamp_ms: 0,
        }
    }

    fn respond_rule(name: &str, url: &str) -> Rule {
        Rule {
            id: name.to_string(),
            name: name.to_string(),
            enabled: true,
            matcher: Matcher {
                method: None,
                url: url.to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: name.to_string(),
                content_type: Some("text/plain".to_string()),
            },
        }
    }

    #[test]
    fn respond_rule_short_circuits() {
        let rs = RuleSet {
            rules: vec![respond_rule("mock", "/health")],
        };
        match rs.evaluate_request(&req("GET", "https", "example.com", "/health")) {
            RequestOutcome::Respond { response, rule } => {
                assert_eq!(rule, "mock");
                assert_eq!(response.status, 200);
                assert_eq!(response.body, b"mock");
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn method_filter_is_respected() {
        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                name: "post-only".into(),
                enabled: true,
                matcher: Matcher {
                    method: Some("POST".into()),
                    url: "".into(),
                    url_match: MatchKind::Contains,
                },
                action: Action::Block,
            }],
        };
        assert!(matches!(
            rs.evaluate_request(&req("GET", "https", "x", "/")),
            RequestOutcome::Continue { .. }
        ));
        assert!(matches!(
            rs.evaluate_request(&req("POST", "https", "x", "/")),
            RequestOutcome::Block { .. }
        ));
    }

    #[test]
    fn response_body_rewrite_regex() {
        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                name: "redact".into(),
                enabled: true,
                matcher: Matcher::default(),
                action: Action::RewriteResponseBody {
                    find: r"\d{4}".into(),
                    replace: "XXXX".into(),
                    regex: true,
                },
            }],
        };
        let mut resp = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: b"card 1234 5678".to_vec(),
            timestamp_ms: 0,
        };
        let matched = rs.apply_response(&req("GET", "https", "x", "/"), &mut resp);
        assert_eq!(matched.as_deref(), Some("redact"));
        assert_eq!(resp.body, b"card XXXX XXXX");
    }

    #[test]
    fn only_active_scenario_applies() {
        let ar = AutoResponder {
            scenarios: vec![
                Scenario {
                    id: "a".into(),
                    name: "A".into(),
                    rules: vec![respond_rule("from-a", "/x")],
                },
                Scenario {
                    id: "b".into(),
                    name: "B".into(),
                    rules: vec![respond_rule("from-b", "/x")],
                },
            ],
            active_scenario_id: Some("b".into()),
        };
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { rule, .. } => assert_eq!(rule, "from-b"),
            other => panic!("expected Respond from scenario b, got {other:?}"),
        }
    }

    #[test]
    fn off_means_passthrough() {
        let ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "a".into(),
                name: "A".into(),
                rules: vec![respond_rule("from-a", "/x")],
            }],
            active_scenario_id: None, // Off
        };
        assert!(matches!(
            ar.evaluate_request(&req("GET", "https", "h", "/x")),
            RequestOutcome::Continue { .. }
        ));
    }

    #[test]
    fn rule_from_flow_seeds_respond_from_response() {
        let flow = Flow {
            id: "f1".into(),
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://x/api".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: vec![],
                timestamp_ms: 0,
            },
            response: Some(CapturedResponse {
                status: 201,
                version: "HTTP/1.1".into(),
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: b"{\"a\":1}".to_vec(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
        };
        let rule = respond_rule_from_flow(&flow, "r1".into());
        assert_eq!(rule.matcher.method.as_deref(), Some("GET"));
        assert_eq!(rule.matcher.url, "https://x/api");
        assert_eq!(rule.name, "GET x/api");
        match rule.action {
            Action::Respond {
                status,
                body,
                content_type,
                ..
            } => {
                assert_eq!(status, 201);
                assert_eq!(body, "{\"a\":1}");
                assert_eq!(content_type.as_deref(), Some("application/json"));
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn rule_from_flow_uses_full_url() {
        let flow = Flow {
            id: "f".into(),
            request: CapturedRequest {
                method: "POST".into(),
                uri: "https://x/api/v2/rum?dd=1&k=abc".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api/v2/rum?dd=1&k=abc".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: vec![],
                timestamp_ms: 0,
            },
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
        };
        // Host-specific full URL preserved (no collapsing) — one rule per request.
        let rule = respond_rule_from_flow(&flow, "r".into());
        assert_eq!(rule.matcher.url, "https://x/api/v2/rum?dd=1&k=abc");
        assert_eq!(rule.matcher.url_match, MatchKind::Contains);
        assert_eq!(rule.name, "POST x/api/v2/rum?dd=1&k=abc");
    }

    #[test]
    fn mock_rule_is_host_specific() {
        let req = |host: &str, path: &str| CapturedRequest {
            method: "GET".into(),
            uri: format!("https://{host}{path}"),
            scheme: "https".into(),
            host: host.into(),
            path: path.into(),
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: vec![],
            timestamp_ms: 0,
        };
        let flow = Flow {
            id: "f".into(),
            request: req("github.com", "/feed"),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
        };
        let rule = respond_rule_from_flow(&flow, "r".into());

        // Mocking github.com/feed must NOT also catch a different host's /feed.
        assert!(rule.matcher.matches(&req("github.com", "/feed")));
        assert!(!rule.matcher.matches(&req("dynatrace.com", "/feed")));
    }
}
