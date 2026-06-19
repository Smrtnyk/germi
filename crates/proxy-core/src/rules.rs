//! The rules engine — Germi's "sprinkles".
//!
//! Rules are grouped into [`Scenario`]s. The [`AutoResponder`] holds many
//! scenarios but only **one is active at a time** (or none — "Off"). The engine
//! evaluates just the active scenario's enabled rules, so you can keep several
//! mock setups around and switch between them instantly.
//!
//! Within a scenario, rules are evaluated in order; the first *short-circuiting*
//! action (Respond / `MapLocal` / Block) wins and the request never hits the
//! network. Non-short-circuiting actions (header/body/status edits) accumulate.
//! Request-phase actions run in `handle_request`; response-phase in
//! `handle_response`.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::flow::{CapturedRequest, CapturedResponse, Flow};

/// Compile-once cache for user rule regexes. The same pattern is evaluated on
/// every intercepted request (and response), so memoize the compiled `Regex`
/// (cloning is cheap — it's internally reference-counted) instead of recompiling
/// per flow. Bounded so a long session that edits many patterns can't grow it
/// without limit; returns `None` for an invalid pattern (callers fall back).
fn cached_regex(pattern: &str) -> Option<Regex> {
    static CACHE: LazyLock<Mutex<HashMap<String, Regex>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut cache = CACHE.lock().ok()?;
    if let Some(re) = cache.get(pattern) {
        return Some(re.clone());
    }
    let re = Regex::new(pattern).ok()?;
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(pattern.to_string(), re.clone());
    Some(re)
}

/// How a [`Matcher`]'s `url` pattern is compared against a flow's URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// Case-sensitive substring match (default — the friendliest).
    #[default]
    Contains,
    /// Exact string equality.
    Exact,
    /// Rust regular expression.
    Regex,
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
            MatchKind::Regex => cached_regex(&self.url).is_some_and(|re| re.is_match(&url)),
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
    #[serde(default)]
    pub fire_limit: Option<u32>,
    #[serde(default)]
    pub repeat: bool,
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

#[derive(Default, Debug)]
pub struct RuleCursors {
    hits: HashMap<String, u32>,
}

impl RuleCursors {
    fn is_exhausted(&self, rule: &Rule) -> bool {
        matches!(rule.fire_limit, Some(limit) if self.hits.get(&rule.id).copied().unwrap_or(0) >= limit)
    }

    fn allows_fire(&self, rule: &Rule) -> bool {
        !self.is_exhausted(rule)
    }

    fn record_fire(&mut self, rule: &Rule) {
        *self.hits.entry(rule.id.clone()).or_insert(0) += 1;
    }

    pub fn reset(&mut self) {
        self.hits.clear();
    }

    pub fn reset_rule(&mut self, id: &str) {
        self.hits.remove(id);
    }

    pub fn reset_missing(&mut self, live_ids: &HashSet<&str>) {
        self.hits.retain(|id, _| live_ids.contains(id.as_str()));
    }

    pub fn snapshot(&self) -> HashMap<String, u32> {
        self.hits.clone()
    }
}

fn first_match(rules: &[Rule], req: &CapturedRequest, cursors: &mut RuleCursors) -> RequestOutcome {
    let mut set_headers = Vec::new();
    for rule in rules.iter().filter(|r| r.enabled && cursors.allows_fire(r)) {
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
                cursors.record_fire(rule);
                return RequestOutcome::Respond {
                    rule: rule.name.clone(),
                    response: SyntheticResponse {
                        status: *status,
                        headers: hs,
                        body: body.clone().into_bytes(),
                    },
                };
            }
            // Missing file: skip this rule rather than break the flow.
            Action::MapLocal { path, status } => {
                if let Ok(bytes) = std::fs::read(path) {
                    let ct = mime_guess::from_path(path)
                        .first_raw()
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    cursors.record_fire(rule);
                    return RequestOutcome::Respond {
                        rule: rule.name.clone(),
                        response: SyntheticResponse {
                            status: *status,
                            headers: vec![("content-type".to_string(), ct)],
                            body: bytes,
                        },
                    };
                }
            }
            Action::Block => {
                cursors.record_fire(rule);
                return RequestOutcome::Block {
                    rule: rule.name.clone(),
                };
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

fn has_exhausted_repeat(rules: &[Rule], req: &CapturedRequest, cursors: &RuleCursors) -> bool {
    rules
        .iter()
        .any(|r| r.enabled && r.repeat && r.matcher.matches(req) && cursors.is_exhausted(r))
}

pub fn evaluate_request_rules_stateful(
    rules: &[Rule],
    req: &CapturedRequest,
    cursors: &mut RuleCursors,
) -> RequestOutcome {
    let outcome = first_match(rules, req, cursors);
    if !matches!(outcome, RequestOutcome::Continue { .. }) {
        return outcome;
    }
    if !has_exhausted_repeat(rules, req, cursors) {
        return outcome;
    }
    for rule in rules.iter().filter(|r| r.matcher.matches(req)) {
        cursors.reset_rule(&rule.id);
    }
    first_match(rules, req, cursors)
}

/// Evaluate request-phase rules in order (shared by `RuleSet`, Scenario, tester).
pub fn evaluate_request_rules(rules: &[Rule], req: &CapturedRequest) -> RequestOutcome {
    let mut scratch = RuleCursors::default();
    evaluate_request_rules_stateful(rules, req, &mut scratch)
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
                // The captured body holds the raw network bytes, which for most
                // real responses are gzip/br/deflate-compressed — decode first so
                // find/replace operates on actual text (otherwise from_utf8 fails
                // and the rule silently no-ops on compressed responses).
                let encoding = crate::body::content_encoding_of(&resp.headers);
                let decoded = match &encoding {
                    Some(enc) => crate::body::try_decompress(enc, &resp.body)
                        .unwrap_or_else(|| resp.body.clone()),
                    None => resp.body.clone(),
                };
                if let Ok(text) = String::from_utf8(decoded) {
                    let new = if *regex {
                        match cached_regex(find) {
                            Some(re) => re.replace_all(&text, replace.as_str()).into_owned(),
                            None => text,
                        }
                    } else {
                        text.replace(find, replace)
                    };
                    resp.body = new.into_bytes();
                    // We replaced the body with its decompressed form, so drop the
                    // now-stale Content-Encoding; the client gets identity bytes
                    // (Content-Length is recomputed downstream in build_parts).
                    if encoding.is_some() {
                        resp.headers
                            .retain(|(k, _)| !k.eq_ignore_ascii_case("content-encoding"));
                    }
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
                fire_limit: None,
                repeat: false,
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

    pub fn evaluate_request_stateful(
        &self,
        req: &CapturedRequest,
        cursors: &mut RuleCursors,
    ) -> RequestOutcome {
        match self.active() {
            Some(s) => evaluate_request_rules_stateful(&s.rules, req, cursors),
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
        fire_limit: None,
        repeat: false,
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
            fire_limit: None,
            repeat: false,
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

    fn respond_rule_limited(name: &str, url: &str, limit: Option<u32>, repeat: bool) -> Rule {
        let mut rule = respond_rule(name, url);
        rule.fire_limit = limit;
        rule.repeat = repeat;
        rule
    }

    fn responded_rule_name(outcome: &RequestOutcome) -> Option<&str> {
        match outcome {
            RequestOutcome::Respond { rule, .. } => Some(rule.as_str()),
            _ => None,
        }
    }

    fn responded_body(outcome: &RequestOutcome) -> Option<&[u8]> {
        match outcome {
            RequestOutcome::Respond { response, .. } => Some(response.body.as_slice()),
            _ => None,
        }
    }

    fn responded_status(outcome: &RequestOutcome) -> Option<u16> {
        match outcome {
            RequestOutcome::Respond { response, .. } => Some(response.status),
            _ => None,
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
                fire_limit: None,
                repeat: false,
                matcher: Matcher {
                    method: Some("POST".into()),
                    url: String::new(),
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
                fire_limit: None,
                repeat: false,
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
    fn response_body_rewrite_decodes_compressed() {
        use std::io::Write;
        // A gzip-encoded response body: the rewrite must decode it, replace, and
        // strip Content-Encoding so the forwarded identity body is consistent.
        let mut enc =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"the secret token").unwrap();
        let gz = enc.finish().unwrap();

        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                name: "redact".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher::default(),
                action: Action::RewriteResponseBody {
                    find: "secret".into(),
                    replace: "public".into(),
                    regex: false,
                },
            }],
        };
        let mut resp = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("Content-Encoding".into(), "gzip".into())],
            body: gz,
            timestamp_ms: 0,
        };
        let matched = rs.apply_response(&req("GET", "https", "x", "/"), &mut resp);
        assert_eq!(matched.as_deref(), Some("redact"));
        assert_eq!(resp.body, b"the public token");
        assert!(
            !resp
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
            "content-encoding must be stripped after decode+rewrite"
        );
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

    #[test]
    fn match_once_consumes_then_falls_through() {
        let mut a = respond_rule_limited("rule-a", "/dup", Some(1), false);
        a.id = "a".into();
        let mut b = respond_rule("rule-b", "/dup");
        b.id = "b".into();
        let rules = vec![a, b];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/dup");

        let first = evaluate_request_rules_stateful(&rules, &r(), &mut cursors);
        assert_eq!(
            responded_rule_name(&first),
            Some("rule-a"),
            "first request must hit the match-once rule A"
        );
        let second = evaluate_request_rules_stateful(&rules, &r(), &mut cursors);
        assert_eq!(
            responded_rule_name(&second),
            Some("rule-b"),
            "after A is consumed the same URL must fall through to B"
        );
        let third = evaluate_request_rules_stateful(&rules, &r(), &mut cursors);
        assert_eq!(
            responded_rule_name(&third),
            Some("rule-b"),
            "unlimited rule B keeps responding"
        );
    }

    #[test]
    fn match_once_then_passthrough_to_network() {
        let rules = vec![respond_rule_limited("once", "/only", Some(1), false)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/only");

        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Respond { .. }
            ),
            "first request is served by the one-shot rule"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "with no fallback rule the second request must hit the network (Continue)"
        );
    }

    #[test]
    fn sequence_advances_foo_then_bar() {
        let mut foo = respond_rule_limited("foo", "/seq", Some(1), false);
        foo.id = "foo".into();
        let mut bar = respond_rule_limited("bar", "/seq", Some(1), false);
        bar.id = "bar".into();
        let rules = vec![foo, bar];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/seq");

        assert_eq!(
            responded_body(&evaluate_request_rules_stateful(&rules, &r(), &mut cursors)),
            Some(&b"foo"[..]),
            "first request yields foo"
        );
        assert_eq!(
            responded_body(&evaluate_request_rules_stateful(&rules, &r(), &mut cursors)),
            Some(&b"bar"[..]),
            "second request yields bar"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "after the sequence is exhausted the request continues to the network"
        );
    }

    #[test]
    fn status_sequence_503_503_200() {
        let status_rule = |id: &str, status: u16| Rule {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            fire_limit: Some(if status == 503 { 2 } else { 1 }),
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/retry".to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status,
                headers: vec![],
                body: String::new(),
                content_type: None,
            },
        };
        let rules = vec![status_rule("down", 503), status_rule("up", 200)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/retry");

        let statuses: Vec<Option<u16>> = (0..3)
            .map(|_| responded_status(&evaluate_request_rules_stateful(&rules, &r(), &mut cursors)))
            .collect();
        assert_eq!(
            statuses,
            vec![Some(503), Some(503), Some(200)],
            "status sequence must be 503, 503, 200"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "fourth request falls through once the status sequence is spent"
        );
    }

    #[test]
    fn repeat_loops_group() {
        let rules = vec![respond_rule_limited("twice", "/loop", Some(2), true)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/loop");

        for label in ["first", "second"] {
            assert!(
                matches!(
                    evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                    RequestOutcome::Respond { .. }
                ),
                "{label} fire within the limit must respond"
            );
        }
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Respond { .. }
            ),
            "third fire must respond because repeat resets the exhausted group"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Respond { .. }
            ),
            "fourth fire still responds (loop continues)"
        );

        let mut a = respond_rule_limited("A", "/cycle", Some(1), true);
        a.id = "A".into();
        let mut b = respond_rule_limited("B", "/cycle", Some(1), true);
        b.id = "B".into();
        let group = vec![a, b];
        let mut group_cursors = RuleCursors::default();
        let gr = || req("GET", "https", "h", "/cycle");

        let order: Vec<Option<String>> = (0..4)
            .map(|_| {
                responded_rule_name(&evaluate_request_rules_stateful(
                    &group,
                    &gr(),
                    &mut group_cursors,
                ))
                .map(str::to_string)
            })
            .collect();
        assert_eq!(
            order,
            vec![
                Some("A".to_string()),
                Some("B".to_string()),
                Some("A".to_string()),
                Some("B".to_string()),
            ],
            "a repeating group must cycle A,B,A,B (group reset), never A,A,A (per-rule wrap)"
        );
    }

    #[test]
    fn fire_limit_none_is_unlimited() {
        let rules = vec![respond_rule_limited("forever", "/x", None, false)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/x");

        for i in 0..50 {
            assert!(
                matches!(
                    evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                    RequestOutcome::Respond { .. }
                ),
                "unlimited rule must fire on request {i}"
            );
        }
        assert!(
            cursors.snapshot().get("forever").copied().unwrap_or(0) >= 50,
            "fires are still counted even when unlimited"
        );
    }

    #[test]
    fn fire_limit_zero_always_skips() {
        let rules = vec![respond_rule_limited("never", "/zero", Some(0), false)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/zero");

        for _ in 0..3 {
            assert!(
                matches!(
                    evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                    RequestOutcome::Continue { .. }
                ),
                "fire_limit Some(0) must never respond"
            );
        }
        assert_eq!(
            cursors.snapshot().get("never").copied().unwrap_or(0),
            0,
            "a never-firing rule records no hits"
        );

        let repeat_zero = vec![respond_rule_limited("never-loop", "/zeroloop", Some(0), true)];
        let mut repeat_cursors = RuleCursors::default();
        assert!(
            matches!(
                evaluate_request_rules_stateful(
                    &repeat_zero,
                    &req("GET", "https", "h", "/zeroloop"),
                    &mut repeat_cursors
                ),
                RequestOutcome::Continue { .. }
            ),
            "Some(0) with repeat must not spin and must yield Continue"
        );
    }

    #[test]
    fn disabled_rule_does_not_consume() {
        let mut rule = respond_rule_limited("off", "/d", Some(1), false);
        rule.enabled = false;
        let rules = vec![rule];
        let mut cursors = RuleCursors::default();

        assert!(
            matches!(
                evaluate_request_rules_stateful(
                    &rules,
                    &req("GET", "https", "h", "/d"),
                    &mut cursors
                ),
                RequestOutcome::Continue { .. }
            ),
            "a disabled rule never responds"
        );
        assert_eq!(
            cursors.snapshot().get("off").copied().unwrap_or(0),
            0,
            "a disabled match-once rule stays at hit count 0"
        );
    }

    #[test]
    fn missing_maplocal_does_not_consume() {
        let rules = vec![Rule {
            id: "map".into(),
            name: "map".into(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/file".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::MapLocal {
                path: "/germi/does/not/exist/abcdef.bin".into(),
                status: 200,
            },
        }];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/file");

        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "a MapLocal with a missing file falls through"
        );
        assert_eq!(
            cursors.snapshot().get("map").copied().unwrap_or(0),
            0,
            "a missing-file MapLocal must not burn its one-shot use"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "still eligible (and still missing) on the next request"
        );
    }

    #[test]
    fn set_request_header_does_not_consume() {
        let rules = vec![Rule {
            id: "hdr".into(),
            name: "hdr".into(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/h".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::SetRequestHeader {
                name: "x-germi".into(),
                value: "1".into(),
            },
        }];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/h");

        for _ in 0..3 {
            match evaluate_request_rules_stateful(&rules, &r(), &mut cursors) {
                RequestOutcome::Continue { set_headers } => assert_eq!(
                    set_headers,
                    vec![("x-germi".to_string(), "1".to_string())],
                    "the header edit must keep applying every request"
                ),
                other => panic!("expected Continue with header, got {other:?}"),
            }
        }
        assert_eq!(
            cursors.snapshot().get("hdr").copied().unwrap_or(0),
            0,
            "a non-short-circuiting header edit never consumes a fire"
        );
    }

    #[test]
    fn reset_restores_consumed() {
        let rules = vec![respond_rule_limited("once", "/r", Some(1), false)];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/r");

        assert!(matches!(
            evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
            RequestOutcome::Respond { .. }
        ));
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "consumed before reset"
        );
        cursors.reset();
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                RequestOutcome::Respond { .. }
            ),
            "after reset the one-shot rule fires again"
        );
    }

    #[test]
    fn reset_rule_only_targets_one() {
        let mut a = respond_rule_limited("A", "/a", Some(1), false);
        a.id = "a".into();
        let mut b = respond_rule_limited("B", "/b", Some(1), false);
        b.id = "b".into();
        let rules = vec![a, b];
        let mut cursors = RuleCursors::default();

        assert!(matches!(
            evaluate_request_rules_stateful(&rules, &req("GET", "https", "h", "/a"), &mut cursors),
            RequestOutcome::Respond { .. }
        ));
        assert!(matches!(
            evaluate_request_rules_stateful(&rules, &req("GET", "https", "h", "/b"), &mut cursors),
            RequestOutcome::Respond { .. }
        ));

        cursors.reset_rule("a");

        assert!(
            matches!(
                evaluate_request_rules_stateful(
                    &rules,
                    &req("GET", "https", "h", "/a"),
                    &mut cursors
                ),
                RequestOutcome::Respond { .. }
            ),
            "reset_rule(a) revives rule A"
        );
        assert!(
            matches!(
                evaluate_request_rules_stateful(
                    &rules,
                    &req("GET", "https", "h", "/b"),
                    &mut cursors
                ),
                RequestOutcome::Continue { .. }
            ),
            "rule B stays consumed after reset_rule(a)"
        );
    }

    #[test]
    fn only_active_scenario_consumes() {
        let ar = AutoResponder {
            scenarios: vec![
                Scenario {
                    id: "a".into(),
                    name: "A".into(),
                    rules: vec![respond_rule_limited("from-a", "/x", Some(1), false)],
                },
                Scenario {
                    id: "b".into(),
                    name: "B".into(),
                    rules: vec![respond_rule_limited("from-b", "/x", Some(1), false)],
                },
            ],
            active_scenario_id: Some("b".into()),
        };
        let mut cursors = RuleCursors::default();

        match ar.evaluate_request_stateful(&req("GET", "https", "h", "/x"), &mut cursors) {
            RequestOutcome::Respond { rule, .. } => assert_eq!(rule, "from-b"),
            other => panic!("expected Respond from scenario b, got {other:?}"),
        }
        let snap = cursors.snapshot();
        assert_eq!(
            snap.get("from-b").copied().unwrap_or(0),
            1,
            "the active scenario's rule advances"
        );
        assert_eq!(
            snap.get("from-a").copied().unwrap_or(0),
            0,
            "an inactive scenario's rule id must not advance"
        );
    }

    #[test]
    fn tester_is_side_effect_free() {
        let rules = vec![respond_rule_limited("once", "/t", Some(1), false)];
        let r = || req("GET", "https", "h", "/t");

        assert!(
            matches!(
                evaluate_request_rules(&rules, &r()),
                RequestOutcome::Respond { .. }
            ),
            "first pure preview responds"
        );
        assert!(
            matches!(
                evaluate_request_rules(&rules, &r()),
                RequestOutcome::Respond { .. }
            ),
            "second pure preview also responds — the offline tester uses a scratch cursor and never advances state"
        );
    }

    #[test]
    fn rule_hits_snapshot_reflects_fires() {
        let mut a = respond_rule_limited("A", "/a", Some(5), false);
        a.id = "a".into();
        let mut b = respond_rule_limited("B", "/b", Some(5), false);
        b.id = "b".into();
        let rules = vec![a, b];
        let mut cursors = RuleCursors::default();

        evaluate_request_rules_stateful(&rules, &req("GET", "https", "h", "/a"), &mut cursors);
        evaluate_request_rules_stateful(&rules, &req("GET", "https", "h", "/a"), &mut cursors);
        evaluate_request_rules_stateful(&rules, &req("GET", "https", "h", "/b"), &mut cursors);

        let snap = cursors.snapshot();
        assert_eq!(snap.get("a").copied(), Some(2), "rule A fired twice");
        assert_eq!(snap.get("b").copied(), Some(1), "rule B fired once");
    }

    #[test]
    fn evaluate_request_stateful_off_is_continue_and_pure() {
        let ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "a".into(),
                name: "A".into(),
                rules: vec![respond_rule_limited("from-a", "/x", Some(1), false)],
            }],
            active_scenario_id: None,
        };
        let mut cursors = RuleCursors::default();

        assert!(
            matches!(
                ar.evaluate_request_stateful(&req("GET", "https", "h", "/x"), &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "Off (no active scenario) must pass through"
        );
        assert!(
            cursors.snapshot().is_empty(),
            "Off must never mutate cursors"
        );
    }
}
