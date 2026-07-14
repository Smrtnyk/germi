//! The rules engine — Germi's "sprinkles".
//!
//! Rules are grouped into [`Scenario`]s. The [`AutoResponder`] holds many
//! scenarios but only **one is active at a time** (or none — "Off"). The engine
//! evaluates just the active scenario's enabled rules, so you can keep several
//! mock setups around and switch between them instantly.
//!
//! Within a scenario, rules are evaluated in order; the first *short-circuiting*
//! action (Respond / `MapLocal` / Block) wins and the request never hits the
//! network. `MapRemote` also ends evaluation, but forwards the request — to a
//! rewritten URL. Non-short-circuiting actions (header/body/status edits)
//! accumulate. Request-phase actions run in `handle_request`; response-phase in
//! `handle_response`.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::flow::{header, CapturedRequest, CapturedResponse, Flow};
use crate::http_semantics::valid_header;

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

/// Which rule fields a deep rule search scans (autoresponder rule filter).
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RuleSearchScope {
    Url,
    Method,
    Status,
    Response,
    Headers,
    All,
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
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
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
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    // --- request-phase, short-circuiting ---
    /// Synthesize a full response and return it without hitting the network.
    Respond {
        status: u16,
        #[serde(default)]
        headers: Vec<(String, String)>,
        #[serde(default)]
        body: String,
        /// Exact response bytes for bodies that cannot be represented as UTF-8.
        /// When present this takes precedence over `body`; the text remains a
        /// best-effort editor preview for older frontends.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body_base64: Option<String>,
        #[serde(default)]
        content_type: Option<String>,
        /// Optional `Content-Encoding` to apply to the served body (e.g.
        /// `gzip` / `br` / `deflate`). When set, `body` is stored decoded
        /// (human-editable in the editor) and compressed on the wire at serve
        /// time; when `None`, `body` is sent as identity bytes. Single token
        /// only — no chained encodings — to match the editor's single toggle.
        #[serde(default)]
        content_encoding: Option<String>,
    },
    /// Serve a local file as the response body (Fiddler "Map Local").
    MapLocal {
        path: String,
        #[serde(default = "default_ok")]
        status: u16,
    },
    /// Forward the request to a different URL instead of the original (Fiddler
    /// "respond with another URL") — transparent to the client, no redirect.
    /// With a [`MatchKind::Regex`] matcher, `$1`…`$n` / `${name}` in the target
    /// insert the pattern's capture groups from the matched URL.
    MapRemote { url: String },
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

    // --- dual-phase ---
    /// Make matching traffic CORS-friendly: answer genuine preflights with a
    /// synthesized 204 (request phase) and stamp echo-based Access-Control
    /// headers on matching responses (response phase). Echoing the request's
    /// `Origin` — never `*` — keeps credentialed requests working.
    Cors,
}

fn default_ok() -> u16 {
    200
}

/// A single rule. Rules are unnamed and identified by `id`; the matcher URL is
/// their human-facing label (see [`Rule::label`]).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub fire_limit: Option<u32>,
    #[serde(default)]
    pub repeat: bool,
    pub matcher: Matcher,
    pub action: Action,
}

impl Rule {
    /// The rule's display label now that rules are unnamed: its matcher URL, or
    /// `*` for a match-all (empty-URL) matcher.
    pub fn label(&self) -> String {
        if self.matcher.url.is_empty() {
            "*".to_string()
        } else {
            self.matcher.url.clone()
        }
    }
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
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// Id of the built-in "General rules" scenario — undeletable, never the active
/// scenario; its rules stack with (evaluate before) the active scenario's when
/// [`AutoResponder::general_active`] is on. The home for cross-cutting rules
/// (global header stamps, CORS headers, body rewrites) that should apply
/// whichever scenario is live, without duplicating them into every scenario.
pub const GENERAL_SCENARIO_ID: &str = "general";
/// Fixed display name of the built-in General scenario (not renamable).
pub const GENERAL_SCENARIO_NAME: &str = "General rules";

/// The autoresponder: many scenarios, at most one active (`None` = Off), plus
/// the built-in General layer that stacks on top of whichever is active.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoResponder {
    #[serde(default)]
    pub scenarios: Vec<Scenario>,
    /// Id of the active scenario, or `None` for Off (plain passthrough). Never
    /// the General scenario — that layer toggles via `general_active` instead.
    #[serde(default)]
    pub active_scenario_id: Option<String>,
    /// Whether the built-in General scenario's rules are evaluated. Independent
    /// of `active_scenario_id`, so General + one scenario can be live together.
    #[serde(default = "default_true")]
    pub general_active: bool,
}

impl Default for AutoResponder {
    fn default() -> Self {
        AutoResponder {
            scenarios: Vec::new(),
            active_scenario_id: None,
            general_active: true,
        }
    }
}

/// Lightweight autoresponder state for the frontend. Rule response bodies and
/// full header tables stay in Rust and are fetched only for the selected rule.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoResponderSummary {
    pub scenarios: Vec<ScenarioSummary>,
    pub active_scenario_id: Option<String>,
    pub general_active: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummary {
    pub id: String,
    pub name: String,
    pub rules: Vec<RuleSummary>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuleSummary {
    pub id: String,
    pub enabled: bool,
    pub fire_limit: Option<u32>,
    pub repeat: bool,
    pub matcher: Matcher,
    pub action: ActionSummary,
}

#[derive(Serialize, Clone, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActionSummary {
    Respond {
        status: u16,
        content_type: Option<String>,
        /// Mirrors [`Action::Respond::content_encoding`] for the rule-list badge.
        #[serde(default)]
        content_encoding: Option<String>,
    },
    MapLocal {
        status: u16,
    },
    MapRemote {
        url: String,
    },
    Block,
    SetRequestHeader {
        name: String,
    },
    SetResponseHeader {
        name: String,
    },
    SetStatus {
        status: u16,
    },
    RewriteResponseBody,
    Cors,
}

impl From<&Action> for ActionSummary {
    fn from(action: &Action) -> Self {
        match action {
            Action::Respond {
                status,
                content_type,
                content_encoding,
                ..
            } => Self::Respond {
                status: *status,
                content_type: content_type.clone(),
                content_encoding: content_encoding.clone(),
            },
            Action::MapLocal { status, .. } => Self::MapLocal { status: *status },
            Action::MapRemote { url } => Self::MapRemote { url: url.clone() },
            Action::Block => Self::Block,
            Action::SetRequestHeader { name, .. } => Self::SetRequestHeader { name: name.clone() },
            Action::SetResponseHeader { name, .. } => {
                Self::SetResponseHeader { name: name.clone() }
            }
            Action::SetStatus { status } => Self::SetStatus { status: *status },
            Action::RewriteResponseBody { .. } => Self::RewriteResponseBody,
            Action::Cors => Self::Cors,
        }
    }
}

impl From<&Rule> for RuleSummary {
    fn from(rule: &Rule) -> Self {
        Self {
            id: rule.id.clone(),
            enabled: rule.enabled,
            fire_limit: rule.fire_limit,
            repeat: rule.repeat,
            matcher: rule.matcher.clone(),
            action: ActionSummary::from(&rule.action),
        }
    }
}

impl From<&Scenario> for ScenarioSummary {
    fn from(scenario: &Scenario) -> Self {
        Self {
            id: scenario.id.clone(),
            name: scenario.name.clone(),
            rules: scenario.rules.iter().map(RuleSummary::from).collect(),
        }
    }
}

impl From<&AutoResponder> for AutoResponderSummary {
    fn from(autoresponder: &AutoResponder) -> Self {
        Self {
            scenarios: autoresponder
                .scenarios
                .iter()
                .map(ScenarioSummary::from)
                .collect(),
            active_scenario_id: autoresponder.active_scenario_id.clone(),
            general_active: autoresponder.general_active,
        }
    }
}

/// A response built entirely by a rule (no upstream request was made).
#[derive(Clone, Debug)]
pub struct SyntheticResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: bytes::Bytes,
}

/// The synthetic 403 served for a `Block` rule (shared by the live handler and
/// the offline tester so both preview and wire stay identical).
pub(crate) fn blocked_response() -> SyntheticResponse {
    SyntheticResponse {
        status: 403,
        headers: vec![("content-type".to_string(), "text/plain".to_string())],
        body: bytes::Bytes::from_static(b"Blocked by Germi"),
    }
}

/// The decision produced by evaluating request-phase rules.
#[derive(Clone, Debug)]
pub enum RequestOutcome {
    /// Forward the request upstream, after applying these header edits.
    Continue { set_headers: Vec<(String, String)> },
    /// Short-circuit with a synthesized response. Carries the rule's URL label + id.
    Respond {
        rule: String,
        rule_id: String,
        response: SyntheticResponse,
        set_headers: Vec<(String, String)>,
    },
    /// Drop the request. Carries the rule's URL label + id.
    Block {
        rule: String,
        rule_id: String,
        set_headers: Vec<(String, String)>,
    },
    /// Forward the request to `url` instead of the original target (Map
    /// Remote). Ends rule evaluation like a short-circuit, but the request
    /// still goes on the wire, so header edits accumulated up to the mapping
    /// rule ride along. Carries the rule's URL label + id.
    MapRemote {
        rule: String,
        rule_id: String,
        url: String,
        set_headers: Vec<(String, String)>,
    },
}

/// Whether an action runs in the request phase (`handle_request`).
fn is_request_phase(action: &Action) -> bool {
    matches!(
        action,
        Action::Respond { .. }
            | Action::MapLocal { .. }
            | Action::MapRemote { .. }
            | Action::Block
            | Action::SetRequestHeader { .. }
            | Action::Cors
    )
}

/// Whether an action runs in the response phase — on upstream responses in
/// `handle_response` AND on rule-synthesized responses before they're served,
/// so response-phase rules describe the response the client sees regardless of
/// who produced it.
fn is_response_phase(action: &Action) -> bool {
    matches!(
        action,
        Action::SetResponseHeader { .. }
            | Action::SetStatus { .. }
            | Action::RewriteResponseBody { .. }
            | Action::Cors
    )
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
        let hits = self.hits.entry(rule.id.clone()).or_insert(0);
        *hits = hits.saturating_add(1);
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

    pub fn restore(&mut self, hits: HashMap<String, u32>) {
        self.hits = hits;
    }
}

/// Upper bound on a `MapLocal` file served as a synthetic response body, mirroring
/// the capture cap. A larger mapping is skipped (treated like a missing file) so a
/// giant or hostile file can't be read entirely into memory on the request path.
const MAP_LOCAL_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Read a `MapLocal` file, returning `None` (skip the rule) for a missing,
/// unreadable, or over-cap file instead of breaking the flow or blowing up memory.
fn read_map_local(path: &str) -> Option<Vec<u8>> {
    read_map_local_capped(path, MAP_LOCAL_MAX_BYTES)
}

fn read_map_local_capped(path: &str, cap: u64) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    // Re-check while reading: a regular file can grow after metadata() and the
    // request path must still never allocate beyond the configured ceiling.
    let mut body = Vec::new();
    file.take(cap.saturating_add(1))
        .read_to_end(&mut body)
        .ok()?;
    ((body.len() as u64) <= cap).then_some(body)
}

/// Rewrite unbraced numeric capture references (`$1`) to their braced form
/// (`${1}`) before regex expansion. The regex crate parses `$name` greedily
/// over `[0-9A-Za-z_]`, so a template like `agent_$1_1.js` would reference the
/// nonexistent group `1_1` and expand to nothing — while every Fiddler/.NET
/// user means "group 1, then the literal `_1.js`". Braced (`${…}`) and escaped
/// (`$$`) references pass through untouched, as do named references (`$name` —
/// group names can't start with a digit, so the digit-run rewrite never
/// clips one).
fn brace_numeric_refs(template: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some(&(_, '$')) => {
                chars.next();
                out.push_str("$$");
            }
            Some(&(start, d)) if d.is_ascii_digit() => {
                let mut end = start;
                while let Some(&(i, c)) = chars.peek() {
                    if !c.is_ascii_digit() {
                        break;
                    }
                    end = i + c.len_utf8();
                    chars.next();
                }
                out.push_str("${");
                out.push_str(&template[start..end]);
                out.push('}');
            }
            _ => out.push('$'),
        }
    }
    out
}

/// Whether a Map Remote target is something the proxy can actually forward to:
/// an absolute `http(s)://` URL with a host.
fn is_forwardable_url(target: &str) -> bool {
    match target.parse::<hudsucker::hyper::Uri>() {
        Ok(uri) => matches!(uri.scheme_str(), Some("http" | "https")) && uri.host().is_some(),
        Err(_) => false,
    }
}

/// Resolve a `MapRemote` rule's forward target for `req`. With a regex matcher,
/// `$1`…`$n` / `${name}` in the template expand to the pattern's capture groups
/// (matched against the same `scheme://host/path` string the matcher saw);
/// other match kinds use the template verbatim. Returns `None` — the rule is
/// skipped, like a `MapLocal` with a missing file — when the pattern no longer
/// compiles/matches or the expansion isn't a forwardable absolute URL.
fn map_remote_target(matcher: &Matcher, req: &CapturedRequest, template: &str) -> Option<String> {
    let target = match matcher.url_match {
        MatchKind::Regex => {
            let url = format!("{}://{}{}", req.scheme, req.host, req.path);
            let caps = cached_regex(&matcher.url)?.captures(&url)?;
            let mut out = String::new();
            caps.expand(&brace_numeric_refs(template), &mut out);
            out
        }
        MatchKind::Contains | MatchKind::Exact => template.to_string(),
    };
    is_forwardable_url(&target).then_some(target)
}

/// A genuine CORS preflight: `OPTIONS` carrying both `Origin` and
/// `Access-Control-Request-Method`. Plain OPTIONS requests are not preflights
/// and must keep flowing through the normal pipeline.
fn is_preflight(req: &CapturedRequest) -> bool {
    req.method.eq_ignore_ascii_case("OPTIONS")
        && header(&req.headers, "origin").is_some_and(|v| !v.is_empty())
        && header(&req.headers, "access-control-request-method").is_some_and(|v| !v.is_empty())
}

/// Synthesize the answer to a preflight: a 204 echoing back exactly what the
/// browser asked for. Echoing (rather than `*`) is what keeps credentialed
/// requests working — browsers reject `*` when cookies/Authorization are sent.
fn preflight_response(req: &CapturedRequest) -> Option<SyntheticResponse> {
    if !is_preflight(req) {
        return None;
    }
    let origin = header(&req.headers, "origin")?;
    let method = header(&req.headers, "access-control-request-method")?;
    let mut headers = vec![
        (
            "access-control-allow-origin".to_string(),
            origin.to_string(),
        ),
        (
            "access-control-allow-methods".to_string(),
            method.to_string(),
        ),
        (
            "access-control-allow-credentials".to_string(),
            "true".to_string(),
        ),
        ("access-control-max-age".to_string(), "600".to_string()),
        (
            "vary".to_string(),
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers".to_string(),
        ),
    ];
    if let Some(requested) =
        header(&req.headers, "access-control-request-headers").filter(|v| !v.is_empty())
    {
        headers.insert(
            2,
            (
                "access-control-allow-headers".to_string(),
                requested.to_string(),
            ),
        );
    }
    Some(SyntheticResponse {
        status: 204,
        headers,
        body: bytes::Bytes::new(),
    })
}

/// Response headers browsers expose to page JS without an
/// `Access-Control-Expose-Headers` entry (the CORS safelist), plus headers that
/// are never exposable (`Set-Cookie`) or meaningless to list (hop-by-hop,
/// recomputed framing, `Vary`).
fn is_expose_excluded(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("access-control-")
        || matches!(
            lower.as_str(),
            "cache-control"
                | "content-language"
                | "content-length"
                | "content-type"
                | "expires"
                | "last-modified"
                | "pragma"
                | "set-cookie"
                | "set-cookie2"
                | "vary"
                | "transfer-encoding"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "upgrade"
        )
}

/// Add `Origin` to the response's `Vary` (creating it if absent) so caches
/// never serve one origin's Allow-Origin echo to another. `Vary: *` already
/// covers everything and is left alone.
fn add_vary_origin(headers: &mut Vec<(String, String)>) {
    match headers
        .iter_mut()
        .find(|(k, _)| k.eq_ignore_ascii_case("vary"))
    {
        Some((_, value)) => {
            let covered = value
                .split(',')
                .any(|t| t.trim() == "*" || t.trim().eq_ignore_ascii_case("origin"));
            if !covered {
                *value = format!("{value}, Origin");
            }
        }
        None => headers.push(("vary".to_string(), "Origin".to_string())),
    }
}

/// Stamp echo-based CORS headers onto a response (mocked or passed through).
/// Existing Allow-Origin values are overwritten — the rule's purpose is forcing
/// permissive CORS, and its matcher scopes what it touches. Expose-Headers is
/// derived from the response's own non-safelisted header names so page JS can
/// read them. Preflights are skipped: matching ones were already answered in
/// the request phase. Returns whether the response was touched.
fn inject_cors(req: &CapturedRequest, resp: &mut CapturedResponse) -> bool {
    if is_preflight(req) {
        return false;
    }
    let Some(origin) = header(&req.headers, "origin").filter(|v| !v.is_empty()) else {
        return false;
    };
    let origin = origin.to_string();
    let mut seen: Vec<String> = Vec::new();
    // Preserve names the upstream explicitly exposed even when they are
    // virtual (not present in this particular response), then add every actual
    // non-safelisted response header. Replacing the upstream list would silently
    // make those virtual headers unreadable to page JavaScript.
    let mut expose: Vec<String> = resp
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("access-control-expose-headers"))
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            if seen.contains(&lower) {
                false
            } else {
                seen.push(lower);
                true
            }
        })
        .collect();
    expose.extend(
        resp.headers
            .iter()
            .map(|(k, _)| k.clone())
            .filter(|k| !is_expose_excluded(k))
            .filter(|k| {
                let lower = k.to_ascii_lowercase();
                if seen.contains(&lower) {
                    false
                } else {
                    seen.push(lower);
                    true
                }
            }),
    );
    if !expose.is_empty() {
        set_header(
            &mut resp.headers,
            "access-control-expose-headers",
            &expose.join(", "),
        );
    }
    set_header(&mut resp.headers, "access-control-allow-origin", &origin);
    set_header(
        &mut resp.headers,
        "access-control-allow-credentials",
        "true",
    );
    add_vary_origin(&mut resp.headers);
    true
}

fn first_match(
    rules: &[Rule],
    req: &CapturedRequest,
    cursors: &mut RuleCursors,
) -> (RequestOutcome, bool) {
    let mut set_headers = Vec::new();
    let mut fired_any = false;
    for rule in rules.iter().filter(|r| r.enabled) {
        if !cursors.allows_fire(rule) {
            continue;
        }
        if !rule.matcher.matches(req) {
            continue;
        }
        match &rule.action {
            Action::Respond { .. } => {
                let response = configured_response(&rule.action);
                cursors.record_fire(rule);
                return (
                    RequestOutcome::Respond {
                        rule: rule.label(),
                        rule_id: rule.id.clone(),
                        response,
                        set_headers,
                    },
                    true,
                );
            }
            // Missing (or too-large) file: skip this rule rather than break the
            // flow. The size cap keeps a huge/hostile mapping from being slurped
            // whole into memory on the request hot path.
            Action::MapLocal { path, status } => {
                if let Some(bytes) = read_map_local(path) {
                    let ct = mime_guess::from_path(path)
                        .first_raw()
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    cursors.record_fire(rule);
                    return (
                        RequestOutcome::Respond {
                            rule: rule.label(),
                            rule_id: rule.id.clone(),
                            response: SyntheticResponse {
                                status: *status,
                                headers: vec![("content-type".to_string(), ct)],
                                body: bytes.into(),
                            },
                            set_headers,
                        },
                        true,
                    );
                }
            }
            // A target that doesn't expand/parse skips the rule rather than
            // break the flow, mirroring MapLocal's missing-file behavior.
            Action::MapRemote { url } => {
                if let Some(target) = map_remote_target(&rule.matcher, req, url) {
                    cursors.record_fire(rule);
                    return (
                        RequestOutcome::MapRemote {
                            rule: rule.label(),
                            rule_id: rule.id.clone(),
                            url: target,
                            set_headers,
                        },
                        true,
                    );
                }
            }
            Action::Block => {
                cursors.record_fire(rule);
                return (
                    RequestOutcome::Block {
                        rule: rule.label(),
                        rule_id: rule.id.clone(),
                        set_headers,
                    },
                    true,
                );
            }
            Action::SetRequestHeader { name, value } => {
                if valid_header(name, value) {
                    set_headers.push((name.clone(), value.clone()));
                    cursors.record_fire(rule);
                    fired_any = true;
                }
            }
            // Preflights are answered here so they neither hit a (possibly
            // dead) upstream nor fall through to a mock rule below and burn
            // its fire budget. Non-preflight requests fall through.
            Action::Cors => {
                if let Some(response) = preflight_response(req) {
                    cursors.record_fire(rule);
                    return (
                        RequestOutcome::Respond {
                            rule: rule.label(),
                            rule_id: rule.id.clone(),
                            response,
                            set_headers,
                        },
                        true,
                    );
                }
            }
            // Response-phase actions are ignored here.
            Action::SetResponseHeader { .. }
            | Action::SetStatus { .. }
            | Action::RewriteResponseBody { .. } => {}
        }
    }
    (RequestOutcome::Continue { set_headers }, fired_any)
}

fn configured_response(action: &Action) -> SyntheticResponse {
    let Action::Respond {
        status,
        headers,
        body,
        body_base64,
        content_type,
        content_encoding,
    } = action
    else {
        unreachable!("configured_response is only called for Respond actions");
    };
    let mut headers = headers.clone();
    // These have dedicated editor fields and must describe the body we build,
    // so stale/duplicate copies in the free-form header table cannot override
    // them or leave identity bytes mislabeled as compressed.
    headers.retain(|(name, _)| {
        !name.eq_ignore_ascii_case("content-type") && !name.eq_ignore_ascii_case("content-encoding")
    });
    if let Some(content_type) = content_type.as_deref().filter(|value| !value.is_empty()) {
        set_header(&mut headers, "content-type", content_type);
    }
    // The stored body is decoded. Compress it only when a supported encoding
    // was selected; an invalid value safely falls back to identity.
    let identity_body = body_base64
        .as_deref()
        .and_then(crate::body::base64_lenient)
        .unwrap_or_else(|| body.as_bytes().to_vec());
    let body = match normalize_encoding(content_encoding.as_deref()) {
        Some(encoding) => match crate::body::compress_body(&encoding, &identity_body) {
            Some(compressed) => {
                set_header(&mut headers, "content-encoding", &encoding);
                compressed
            }
            None => identity_body,
        },
        None => identity_body,
    };
    SyntheticResponse {
        status: *status,
        headers,
        body: body.into(),
    }
}

/// Whether a request-phase repeat group on this URL has run dry and should loop.
/// A rule that can never fire (`fire_limit == Some(0)`) is not a looping group.
fn is_repeat_loop(rule: &Rule, req: &CapturedRequest, cursors: &RuleCursors) -> bool {
    rule.enabled
        && rule.repeat
        && is_request_phase(&rule.action)
        && matches!(rule.fire_limit, Some(limit) if limit > 0)
        && rule.matcher.matches(req)
        && request_action_can_fire(rule, req)
        && cursors.is_exhausted(rule)
}

/// Whether a matching request-phase rule is currently capable of consuming a
/// fire. Repeat-cycle bookkeeping must ignore rules that `first_match` would
/// skip (for example a missing `MapLocal` file); otherwise that permanently
/// unspent sibling can prevent the rest of the repeat group from looping.
fn request_action_can_fire(rule: &Rule, req: &CapturedRequest) -> bool {
    match &rule.action {
        Action::Respond { .. } | Action::Block => true,
        Action::MapLocal { path, .. } => std::fs::File::open(path)
            .and_then(|file| file.metadata())
            .is_ok_and(|meta| meta.is_file() && meta.len() <= MAP_LOCAL_MAX_BYTES),
        Action::MapRemote { url } => map_remote_target(&rule.matcher, req, url).is_some(),
        Action::SetRequestHeader { name, value } => valid_header(name, value),
        Action::Cors => is_preflight(req),
        Action::SetResponseHeader { .. }
        | Action::SetStatus { .. }
        | Action::RewriteResponseBody { .. } => false,
    }
}

/// Whether this request has a real finite request-phase repeat member that can
/// revive. Shared with the offline tester so a transient Continue inside a
/// repeat cycle is not mistaken for its permanent steady state.
pub(crate) fn has_request_repeat_cycle(rules: &[Rule], req: &CapturedRequest) -> bool {
    rules.iter().any(|rule| {
        rule.enabled
            && rule.repeat
            && is_request_phase(&rule.action)
            && matches!(rule.fire_limit, Some(limit) if limit > 0)
            && rule.matcher.matches(req)
            && request_action_can_fire(rule, req)
    })
}

/// A repeat cycle whose finite members are all spent can be revived before the
/// next request is evaluated. Doing this up front avoids a pass-through rule
/// (for example an unlimited request-header edit) masking the exhausted group
/// and starving it forever.
fn repeat_cycle_is_spent(rules: &[Rule], req: &CapturedRequest, cursors: &RuleCursors) -> bool {
    let mut found = false;
    let all_spent = rules
        .iter()
        .filter(|rule| {
            rule.enabled
                && rule.repeat
                && is_request_phase(&rule.action)
                && matches!(rule.fire_limit, Some(limit) if limit > 0)
                && rule.matcher.matches(req)
                && request_action_can_fire(rule, req)
        })
        .all(|rule| {
            found = true;
            cursors.is_exhausted(rule)
        });
    found && all_spent
}

fn reset_request_repeat_rules(rules: &[Rule], req: &CapturedRequest, cursors: &mut RuleCursors) {
    for rule in rules.iter().filter(|r| {
        r.enabled
            && r.repeat
            && matches!(r.fire_limit, Some(limit) if limit > 0)
            && is_request_phase(&r.action)
            && r.matcher.matches(req)
    }) {
        cursors.reset_rule(&rule.id);
    }
}

pub fn evaluate_request_rules_stateful(
    rules: &[Rule],
    req: &CapturedRequest,
    cursors: &mut RuleCursors,
) -> RequestOutcome {
    if repeat_cycle_is_spent(rules, req, cursors) {
        reset_request_repeat_rules(rules, req, cursors);
    }
    let (outcome, fired_any) = first_match(rules, req, cursors);
    if !matches!(outcome, RequestOutcome::Continue { .. }) {
        return outcome;
    }
    // A pass-through rule fired on this request. Do not immediately revive an
    // exhausted repeat group and apply it twice to the same request.
    if fired_any {
        return outcome;
    }
    if !rules.iter().any(|r| is_repeat_loop(r, req, cursors)) {
        return outcome;
    }
    // Only revive the looping (enabled, repeat) request-phase rules — never a
    // finite one-shot or a disabled sibling sharing the URL, whose cursors must
    // stay exhausted.
    reset_request_repeat_rules(rules, req, cursors);
    first_match(rules, req, cursors).0
}

/// Evaluate request-phase rules in order (shared by `RuleSet`, Scenario, tester).
pub fn evaluate_request_rules(rules: &[Rule], req: &CapturedRequest) -> RequestOutcome {
    let mut scratch = RuleCursors::default();
    evaluate_request_rules_stateful(rules, req, &mut scratch)
}

/// Apply response-phase rules in order, mutating `resp`, honoring each rule's
/// `fire_limit`/`repeat` via `cursors`. Returns the last rule that changed it.
pub fn apply_response_rules_stateful(
    rules: &[Rule],
    req: &CapturedRequest,
    resp: &mut CapturedResponse,
    cursors: &mut RuleCursors,
) -> Option<String> {
    apply_response_rules_stateful_mode(rules, req, resp, cursors, true)
}

/// Response-rule evaluation for a streaming/incomplete body. Metadata actions
/// still apply, while a body rewrite is skipped without spending its fire
/// budget because the handler cannot safely replace bytes it did not buffer.
pub(crate) fn apply_response_rules_stateful_mode(
    rules: &[Rule],
    req: &CapturedRequest,
    resp: &mut CapturedResponse,
    cursors: &mut RuleCursors,
    allow_body_rewrite: bool,
) -> Option<String> {
    let mut matched = None;
    for rule in rules
        .iter()
        .filter(|r| r.enabled && is_response_phase(&r.action))
    {
        if !rule.matcher.matches(req) {
            continue;
        }
        if !cursors.allows_fire(rule) {
            // A spent repeat rule loops (reset and fire again); a spent finite
            // rule stays spent.
            if rule.repeat && matches!(rule.fire_limit, Some(l) if l > 0) {
                cursors.reset_rule(&rule.id);
            } else {
                continue;
            }
        }
        let fired = match &rule.action {
            Action::SetResponseHeader { name, value } if valid_header(name, value) => {
                set_header(&mut resp.headers, name, value);
                true
            }
            Action::SetStatus { status } => {
                resp.status = *status;
                true
            }
            Action::RewriteResponseBody {
                find,
                replace,
                regex,
            } => allow_body_rewrite && rewrite_response_body(resp, find, replace, *regex),
            Action::Cors => inject_cors(req, resp),
            _ => false,
        };
        if fired {
            cursors.record_fire(rule);
            matched = Some(rule.label());
        }
    }
    matched
}

/// Side-effect-free response apply (scratch cursor) — for the offline tester and
/// previews, where rules must not consume their fire budget.
pub fn apply_response_rules(
    rules: &[Rule],
    req: &CapturedRequest,
    resp: &mut CapturedResponse,
) -> Option<String> {
    let mut scratch = RuleCursors::default();
    apply_response_rules_stateful(rules, req, resp, &mut scratch)
}

/// Find/replace in a response body, decoding its Content-Encoding chain first so
/// the rewrite operates on real text. Returns whether the body was changed.
/// A body that exceeded the decompression cap is left untouched — rewriting +
/// forwarding a truncated identity body would corrupt the response on the wire.
fn rewrite_response_body(
    resp: &mut CapturedResponse,
    find: &str,
    replace: &str,
    regex: bool,
) -> bool {
    let had_encoding = !crate::body::content_encodings_of(&resp.headers).is_empty();
    let (decoded, truncated) = match crate::body::decode_body(&resp.headers, &resp.body) {
        Some((d, t)) => (d, t),
        None => (resp.body.to_vec(), false),
    };
    if truncated {
        return false;
    }
    let Ok(text) = String::from_utf8(decoded) else {
        return false;
    };
    let Some(new) = rewrite_text_capped(
        &text,
        find,
        replace,
        regex,
        crate::body::MAX_DECOMPRESSED_BYTES,
    ) else {
        return false;
    };
    // No match ⇒ nothing changed: report no-op so the caller doesn't burn the
    // fire budget, stamp "Mocked-by", or strip Content-Encoding on an untouched
    // body (which would serve it decompressed for no reason).
    if new == text {
        return false;
    }
    // A byte-range response describes offsets in the selected representation.
    // A length change makes those offsets false. Decoding an encoded range and
    // serving it as identity changes the selected representation regardless of
    // decoded length, so that is unsafe too.
    let has_content_range = resp
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-range"));
    if has_content_range && (had_encoding || new.len() != text.len()) {
        return false;
    }
    resp.body = new.into();
    // The body is now a different identity representation. Framing is rebuilt
    // downstream, but validators, digests, ranges, and message signatures also
    // describe the old bytes and must not be forwarded as if still valid.
    resp.headers.retain(|(name, _)| {
        !(is_stale_after_body_rewrite(name)
            || had_encoding && name.eq_ignore_ascii_case("content-encoding"))
    });
    true
}

fn is_stale_after_body_rewrite(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "etag"
            | "last-modified"
            | "content-md5"
            | "digest"
            | "content-digest"
            | "repr-digest"
            | "signature"
            | "signature-input"
    )
}

/// Apply a literal or regex replacement without letting a compact captured body
/// amplify beyond the proxy's body ceiling. `None` means invalid regex or an
/// over-cap result; callers leave the original response and cursor untouched.
fn rewrite_text_capped(
    text: &str,
    find: &str,
    replace: &str,
    regex: bool,
    cap: usize,
) -> Option<String> {
    if !regex {
        let matches = text.match_indices(find).count();
        let removed = matches.checked_mul(find.len())?;
        let added = matches.checked_mul(replace.len())?;
        let size = text.len().checked_sub(removed)?.checked_add(added)?;
        return (size <= cap).then(|| text.replace(find, replace));
    }

    let re = cached_regex(find)?;
    let mut out = String::with_capacity(text.len().min(cap));
    let mut last = 0;
    for captures in re.captures_iter(text) {
        let matched = captures.get(0)?;
        push_rewrite_piece(&mut out, &text[last..matched.start()], cap)?;
        let expanded_len = expanded_replacement_len(&captures, replace)?;
        (out.len().checked_add(expanded_len)? <= cap).then_some(())?;
        let before = out.len();
        captures.expand(replace, &mut out);
        debug_assert_eq!(out.len() - before, expanded_len);
        last = matched.end();
    }
    push_rewrite_piece(&mut out, &text[last..], cap)?;
    Some(out)
}

/// Exact byte length that `regex::Captures::expand` will append. Measuring the
/// replacement before expansion prevents a `$0$0...` template from allocating
/// a many-times-over-cap temporary only to be rejected afterward.
fn expanded_replacement_len(captures: &regex::Captures<'_>, replacement: &str) -> Option<usize> {
    let mut rest = replacement;
    let mut len = 0usize;
    while let Some(dollar) = rest.find('$') {
        len = len.checked_add(dollar)?;
        rest = &rest[dollar..];
        if rest.as_bytes().get(1) == Some(&b'$') {
            len = len.checked_add(1)?;
            rest = &rest[2..];
            continue;
        }

        let after_dollar = &rest[1..];
        let capture = if let Some(braced) = after_dollar.strip_prefix('{') {
            braced
                .find('}')
                .map(|end| (&braced[..end], 1 + 1 + end + 1))
        } else {
            let end = after_dollar
                .bytes()
                .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                .count();
            (end > 0).then(|| (&after_dollar[..end], 1 + end))
        };
        let Some((reference, consumed)) = capture else {
            // A '$' that doesn't begin a valid reference is literal.
            len = len.checked_add(1)?;
            rest = after_dollar;
            continue;
        };
        let captured_len = reference
            .parse::<usize>()
            .ok()
            .and_then(|index| captures.get(index))
            .or_else(|| captures.name(reference))
            .map_or(0, |matched| matched.as_str().len());
        len = len.checked_add(captured_len)?;
        rest = &rest[consumed..];
    }
    len.checked_add(rest.len())
}

fn push_rewrite_piece(out: &mut String, piece: &str, cap: usize) -> Option<()> {
    (out.len().checked_add(piece.len())? <= cap).then(|| out.push_str(piece))
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
                    body_base64: None,
                    content_type: Some("application/json".to_string()),
                    content_encoding: None,
                },
            }],
        }
    }
}

impl AutoResponder {
    /// The active scenario, or `None` when Off. The built-in General scenario is
    /// never "active" — it stacks via [`Self::general_active`] instead, so an
    /// `active_scenario_id` pointing at it resolves to `None`.
    pub fn active(&self) -> Option<&Scenario> {
        match &self.active_scenario_id {
            Some(id) if id != GENERAL_SCENARIO_ID => self.scenarios.iter().find(|s| &s.id == id),
            _ => None,
        }
    }

    /// The built-in General scenario, if present.
    pub fn general(&self) -> Option<&Scenario> {
        self.scenarios.iter().find(|s| s.id == GENERAL_SCENARIO_ID)
    }

    /// The rules the General layer contributes to evaluation: empty when the
    /// layer is toggled off or the scenario is absent.
    fn general_rules(&self) -> &[Rule] {
        if !self.general_active {
            return &[];
        }
        self.general().map_or(&[], |s| s.rules.as_slice())
    }

    /// The active scenario's rules, or an empty slice when Off.
    fn active_rules(&self) -> &[Rule] {
        self.active().map_or(&[], |s| s.rules.as_slice())
    }

    /// Rule ids that can hold live cursors: the General layer's (when on) plus
    /// the active scenario's — exactly the rules `evaluate_*`/`apply_*` consult.
    /// Cursor reconciliation retains only these.
    pub fn evaluated_rule_ids(&self) -> HashSet<&str> {
        self.general_rules()
            .iter()
            .chain(self.active_rules())
            .map(|r| r.id.as_str())
            .collect()
    }

    /// Guarantee the built-in General scenario exists with its canonical name
    /// and sits first in the list. Also normalize an invalid switchable active
    /// pointer to Off (including one that aliases General).
    pub fn ensure_general(&mut self) {
        match self
            .scenarios
            .iter()
            .position(|s| s.id == GENERAL_SCENARIO_ID)
        {
            Some(0) => {}
            Some(pos) => {
                let general = self.scenarios.remove(pos);
                self.scenarios.insert(0, general);
            }
            None => self.scenarios.insert(
                0,
                Scenario {
                    id: GENERAL_SCENARIO_ID.to_string(),
                    name: GENERAL_SCENARIO_NAME.to_string(),
                    rules: Vec::new(),
                },
            ),
        }

        // The id is the durable identity of this built-in layer. An old or
        // hand-edited database may still carry a different display name even
        // though every mutation path correctly rejects renaming General.
        self.scenarios[0].name = GENERAL_SCENARIO_NAME.to_string();

        if self.active_scenario_id.as_deref().is_some_and(|active_id| {
            active_id == GENERAL_SCENARIO_ID
                || !self
                    .scenarios
                    .iter()
                    .any(|scenario| scenario.id == active_id)
        }) {
            self.active_scenario_id = None;
        }
    }

    pub fn evaluate_request(&self, req: &CapturedRequest) -> RequestOutcome {
        let mut scratch = RuleCursors::default();
        self.evaluate_request_stateful(req, &mut scratch)
    }

    /// Evaluate the General layer first (a general rule wins the short-circuit
    /// and shields the active scenario's mocks from general-layer requests),
    /// then the active scenario. Request-header edits from both layers
    /// accumulate; the first short-circuiting action from either layer wins.
    /// A `MapRemote` from the active scenario keeps the General layer's header
    /// edits — the request still goes on the wire, just to a different URL.
    pub fn evaluate_request_stateful(
        &self,
        req: &CapturedRequest,
        cursors: &mut RuleCursors,
    ) -> RequestOutcome {
        let mut merged = match evaluate_request_rules_stateful(self.general_rules(), req, cursors) {
            RequestOutcome::Continue { set_headers } => set_headers,
            short_circuit => return short_circuit,
        };
        match evaluate_request_rules_stateful(self.active_rules(), req, cursors) {
            RequestOutcome::Continue { set_headers } => {
                merged.extend(set_headers);
                RequestOutcome::Continue {
                    set_headers: merged,
                }
            }
            RequestOutcome::MapRemote {
                rule,
                rule_id,
                url,
                set_headers,
            } => {
                merged.extend(set_headers);
                RequestOutcome::MapRemote {
                    rule,
                    rule_id,
                    url,
                    set_headers: merged,
                }
            }
            RequestOutcome::Respond {
                rule,
                rule_id,
                response,
                set_headers,
            } => {
                merged.extend(set_headers);
                RequestOutcome::Respond {
                    rule,
                    rule_id,
                    response,
                    set_headers: merged,
                }
            }
            RequestOutcome::Block {
                rule,
                rule_id,
                set_headers,
            } => {
                merged.extend(set_headers);
                RequestOutcome::Block {
                    rule,
                    rule_id,
                    set_headers: merged,
                }
            }
        }
    }

    pub fn apply_response(
        &self,
        req: &CapturedRequest,
        resp: &mut CapturedResponse,
    ) -> Option<String> {
        let mut scratch = RuleCursors::default();
        self.apply_response_stateful(req, resp, &mut scratch)
    }

    /// Apply response-phase rules — General layer first, then the active
    /// scenario — advancing `cursors` (the live handler path — honors
    /// `fire_limit`/`repeat`). Returns the last rule that changed the response.
    pub fn apply_response_stateful(
        &self,
        req: &CapturedRequest,
        resp: &mut CapturedResponse,
        cursors: &mut RuleCursors,
    ) -> Option<String> {
        self.apply_response_stateful_mode(req, resp, cursors, true)
    }

    pub(crate) fn apply_response_stateful_mode(
        &self,
        req: &CapturedRequest,
        resp: &mut CapturedResponse,
        cursors: &mut RuleCursors,
        allow_body_rewrite: bool,
    ) -> Option<String> {
        let general = apply_response_rules_stateful_mode(
            self.general_rules(),
            req,
            resp,
            cursors,
            allow_body_rewrite,
        );
        let scenario = apply_response_rules_stateful_mode(
            self.active_rules(),
            req,
            resp,
            cursors,
            allow_body_rewrite,
        );
        scenario.or(general)
    }

    /// A starter autoresponder: the built-in General scenario plus one example
    /// scenario, Off by default.
    pub fn example() -> Self {
        let mut ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "default".to_string(),
                name: "My mocks".to_string(),
                rules: RuleSet::example().rules,
            }],
            active_scenario_id: None,
            general_active: true,
        };
        ar.ensure_general();
        ar
    }
}

pub fn blank_rule(id: String) -> Rule {
    Rule {
        id,
        enabled: true,
        fire_limit: None,
        repeat: false,
        // Contains (the friendly default): an empty pattern matches every
        // request, which is what a freshly-added rule wants (and what the
        // editor's "empty URL matches every request" hint promises). Exact with
        // an empty URL would match *nothing* (`url == ""` is never true) — a
        // silent no-op footgun. `respond_rule_from_flow` overrides to Exact
        // because it seeds a specific full URL.
        matcher: Matcher {
            method: None,
            url: String::new(),
            url_match: MatchKind::Contains,
        },
        action: Action::Respond {
            status: 200,
            headers: Vec::new(),
            body: "{\n  \"mocked\": true\n}".to_string(),
            body_base64: None,
            content_type: Some("application/json".to_string()),
            content_encoding: None,
        },
    }
}

/// Build a `Respond` rule seeded from a captured flow — matcher targets the same
/// method + path, action replays the captured response (status, content-type,
/// body). This is the "Mock this" / bulk "Add to scenario" seed.
///
/// The seeded body is always **decoded** (identity text), regardless of the
/// original `Content-Encoding`: the editor shows readable text, and the
/// original encoding is preserved in `content_encoding` so the engine
/// re-compresses on serve and the wire matches the original. A body that can't
/// be decoded (unknown encoding, or a decode-truncated bomb) falls back to the
/// raw bytes with no encoding — the user gets *something* to look at rather than
/// a destroyed gzip stream mislabeled as `application/json`.
pub fn respond_rule_from_flow(flow: &Flow, id: String) -> Rule {
    let (status, body, body_base64, content_type, headers, content_encoding) = match &flow.response
    {
        Some(r) => {
            let ct = r
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone());
            // Preserve only one supported Content-Encoding token. A chain must
            // be dropped because the rule editor/serving path has one toggle;
            // keeping just its first token after decoding the full chain would
            // serve different bytes under a misleading partial encoding.
            let original_encodings = crate::body::content_encodings_of(&r.headers);
            let original_encoding = match original_encodings.as_slice() {
                [encoding] => normalize_encoding(Some(encoding)),
                _ => None,
            };
            // Get the body into identity (decoded) form for the editor, and
            // decide whether to keep the encoding toggle.
            //
            // Three cases:
            // 1. decode_body succeeds → the body was raw compressed (a live
            //    capture). Use the decoded text + keep the encoding toggle.
            // 2. decode_body fails but the body is already textual → tolerate a
            //    legacy import (older Germi builds retained Content-Encoding
            //    beside decoded bytes) or a stale upstream header. Use the body
            //    as-is + KEEP the encoding toggle so the engine re-compresses
            //    on serve (the client still receives the same decoded payload).
            // 3. decode_body fails and the body is NOT textual → genuinely
            //    undecodable binary. Fall back to raw bytes with NO encoding
            //    toggle — serving a truncated/undecodable body labeled gzip
            //    would corrupt the response.
            let (decoded, encoding) = match crate::body::decode_body(&r.headers, &r.body) {
                Some((decoded, false)) => (decoded, original_encoding),
                _ if crate::body::looks_textual(&r.body) => (r.body.to_vec(), original_encoding),
                _ => (r.body.to_vec(), None),
            };
            // Seed only metadata that remains true for the configured mock.
            // Body/framing fields are recomputed, while validators, digests,
            // ranges, and message signatures describe the captured bytes and
            // become false as soon as Germi decodes, recompresses, or edits them.
            let headers: Vec<(String, String)> = r
                .headers
                .iter()
                .filter(|(k, _)| !is_seed_excluded(k))
                .cloned()
                .collect();
            let body_base64 = (std::str::from_utf8(&decoded).is_err()
                || !crate::body::looks_textual(&decoded))
            .then(|| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&decoded)
            });
            (
                r.status,
                String::from_utf8_lossy(&decoded).into_owned(),
                body_base64,
                ct,
                headers,
                encoding,
            )
        }
        None => (200, String::new(), None, None, Vec::new(), None),
    };

    // One rule per request, host-specific: the matcher targets the flow's full
    // URL (scheme://host/path+query) so mocking github.com/feed does NOT also
    // catch dynatrace.com/feed. Fiddler-style — nothing is collapsed. The full
    // URL is also the rule's display label (rules are unnamed).
    let full_url = format!(
        "{}://{}{}",
        flow.request.scheme, flow.request.host, flow.request.path
    );

    Rule {
        id,
        enabled: true,
        fire_limit: None,
        repeat: false,
        matcher: Matcher {
            method: Some(flow.request.method.clone()),
            url: full_url,
            url_match: MatchKind::Exact,
        },
        action: Action::Respond {
            status,
            headers,
            body,
            body_base64,
            content_type,
            content_encoding,
        },
    }
}

/// Headers that should NOT be copied into a seeded mock: dedicated body fields,
/// hop-by-hop/framing metadata, and integrity/range metadata that describes the
/// captured bytes rather than the independently configured mock body.
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
            | "etag"
            | "last-modified"
            | "content-md5"
            | "digest"
            | "content-digest"
            | "repr-digest"
            | "content-range"
            | "signature"
            | "signature-input"
    )
}

/// Normalize a `Content-Encoding` toggle value: trim/lowercase, drop empty and
/// `identity` (both mean "no encoding"). Returns the canonical single token to
/// stamp as the header value and pass to `compress_body`, or `None` when the
/// response should be served as identity bytes. Only supported single tokens
/// are returned. Rejecting a comma-separated chain
/// matters: compressing once while stamping `gzip, br` would make the client try
/// to undo two encodings and fail.
fn normalize_encoding(encoding: Option<&str>) -> Option<String> {
    let enc = encoding?.trim().to_ascii_lowercase();
    match enc.as_str() {
        "gzip" | "x-gzip" => Some("gzip".to_string()),
        "deflate" | "x-deflate" => Some("deflate".to_string()),
        "br" => Some(enc),
        _ => None,
    }
}

/// Insert or replace a header (case-insensitive on the name).
fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    let first = headers
        .iter()
        .position(|(k, _)| k.eq_ignore_ascii_case(name));
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    let replacement = (name.to_string(), value.to_string());
    if let Some(index) = first {
        headers.insert(index.min(headers.len()), replacement);
    } else {
        headers.push(replacement);
    }
}

/// Apply request-header rules with the same case-insensitive replacement
/// semantics used by response-header rules and the live wire request.
pub(crate) fn apply_request_header_edits(
    headers: &mut Vec<(String, String)>,
    edits: &[(String, String)],
) {
    for (name, value) in edits {
        set_header(headers, name, value);
    }
}

/// The status text a rule's action contributes to a `Status`-scope search.
fn action_status_text(action: &Action) -> Option<String> {
    match action {
        Action::Respond { status, .. }
        | Action::MapLocal { status, .. }
        | Action::SetStatus { status } => Some(status.to_string()),
        _ => None,
    }
}

/// The response-body text a rule's action contributes to a `Response`-scope search.
fn action_response_text(action: &Action) -> Option<&str> {
    match action {
        Action::Respond { body, .. } => Some(body),
        _ => None,
    }
}

/// The URL text a rule's action contributes to a `Url`-scope search (a Map
/// Remote's target — so searching "localhost:8080" finds the mappings, not
/// just the matchers).
fn action_url_text(action: &Action) -> Option<&str> {
    match action {
        Action::MapRemote { url } => Some(url),
        _ => None,
    }
}

/// The header name/value text a rule's action contributes to a `Headers`-scope
/// search: a `Respond`'s header table plus its content-type, and the name/value
/// of header-setting actions, rendered as one `name: value` per line.
fn action_header_text(action: &Action) -> String {
    let mut lines: Vec<String> = Vec::new();
    match action {
        Action::Respond {
            headers,
            content_type,
            ..
        } => {
            lines.extend(headers.iter().map(|(k, v)| format!("{k}: {v}")));
            if let Some(ct) = content_type {
                lines.push(format!("content-type: {ct}"));
            }
        }
        Action::SetRequestHeader { name, value } | Action::SetResponseHeader { name, value } => {
            lines.push(format!("{name}: {value}"));
        }
        _ => {}
    }
    lines.join("\n")
}

/// Whether a single (non-`All`) scope's text for `rule` contains `needle`
/// (case-insensitive). `needle` is already lowercased by the caller.
fn scope_text_matches(rule: &Rule, scope: RuleSearchScope, needle: &str) -> bool {
    let contains = |text: &str| text.to_lowercase().contains(needle);
    match scope {
        RuleSearchScope::Url => {
            contains(&rule.matcher.url) || action_url_text(&rule.action).is_some_and(contains)
        }
        RuleSearchScope::Method => rule.matcher.method.as_deref().is_some_and(contains),
        RuleSearchScope::Status => action_status_text(&rule.action).is_some_and(|s| contains(&s)),
        RuleSearchScope::Response => action_response_text(&rule.action).is_some_and(contains),
        RuleSearchScope::Headers => contains(&action_header_text(&rule.action)),
        RuleSearchScope::All => true,
    }
}

/// Whether `rule` matches `needle` under `scope`. `All` ORs the concrete scopes.
/// `needle` must already be lowercased.
pub(crate) fn rule_matches_scope(rule: &Rule, scope: RuleSearchScope, needle: &str) -> bool {
    match scope {
        RuleSearchScope::All => [
            RuleSearchScope::Url,
            RuleSearchScope::Method,
            RuleSearchScope::Status,
            RuleSearchScope::Response,
            RuleSearchScope::Headers,
        ]
        .iter()
        .any(|s| scope_text_matches(rule, *s, needle)),
        other => scope_text_matches(rule, other, needle),
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
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        }
    }

    fn respond_rule(name: &str, url: &str) -> Rule {
        Rule {
            id: name.to_string(),
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
                body_base64: None,
                content_type: Some("text/plain".to_string()),
                content_encoding: None,
            },
        }
    }

    fn respond_rule_limited(name: &str, url: &str, limit: Option<u32>, repeat: bool) -> Rule {
        let mut rule = respond_rule(name, url);
        rule.fire_limit = limit;
        rule.repeat = repeat;
        rule
    }

    fn responded_rule_id(outcome: &RequestOutcome) -> Option<&str> {
        match outcome {
            RequestOutcome::Respond { rule_id, .. } => Some(rule_id.as_str()),
            _ => None,
        }
    }

    fn responded_body(outcome: &RequestOutcome) -> Option<&[u8]> {
        match outcome {
            RequestOutcome::Respond { response, .. } => Some(&response.body),
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
            RequestOutcome::Respond { response, rule, .. } => {
                assert_eq!(rule, "/health");
                assert_eq!(response.status, 200);
                assert_eq!(response.body, b"mock".as_slice());
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn method_filter_is_respected() {
        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
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
            body: b"card 1234 5678".to_vec().into(),
            timestamp_ms: 0,
        };
        let matched = rs.apply_response(&req("GET", "https", "x", "/"), &mut resp);
        assert_eq!(matched.as_deref(), Some("*"));
        assert_eq!(resp.body, b"card XXXX XXXX".as_slice());
    }

    #[test]
    fn response_body_rewrite_decodes_compressed() {
        use std::io::Write;
        // A gzip-encoded response body: the rewrite must decode it, replace, and
        // strip Content-Encoding so the forwarded identity body is consistent.
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"the secret token").unwrap();
        let gz = enc.finish().unwrap();

        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
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
            body: gz.into(),
            timestamp_ms: 0,
        };
        let matched = rs.apply_response(&req("GET", "https", "x", "/"), &mut resp);
        assert_eq!(matched.as_deref(), Some("*"));
        assert_eq!(resp.body, b"the public token".as_slice());
        assert!(
            !resp
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
            "content-encoding must be stripped after decode+rewrite"
        );
    }

    #[test]
    fn response_body_rewrite_drops_stale_validators_digests_and_signatures() {
        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher::default(),
                action: Action::RewriteResponseBody {
                    find: "old".into(),
                    replace: "new body".into(),
                    regex: false,
                },
            }],
        };
        let mut resp = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![
                ("ETag".into(), "\"old\"".into()),
                ("Last-Modified".into(), "yesterday".into()),
                ("Content-Digest".into(), "sha-256=:old:".into()),
                ("Signature".into(), "sig1=:old:".into()),
                ("X-Keep".into(), "yes".into()),
            ],
            body: b"old".to_vec().into(),
            timestamp_ms: 0,
        };

        assert!(rs
            .apply_response(&req("GET", "https", "x", "/"), &mut resp)
            .is_some());
        assert_eq!(resp.body, b"new body".as_slice());
        assert_eq!(resp.headers, vec![("X-Keep".into(), "yes".into())]);
    }

    #[test]
    fn response_body_rewrite_skips_length_changing_partial_content() {
        let rs = RuleSet {
            rules: vec![Rule {
                id: "1".into(),
                enabled: true,
                fire_limit: Some(1),
                repeat: false,
                matcher: Matcher::default(),
                action: Action::RewriteResponseBody {
                    find: "old".into(),
                    replace: "longer".into(),
                    regex: false,
                },
            }],
        };
        let original_headers = vec![("Content-Range".into(), "bytes 0-2/100".into())];
        let mut resp = CapturedResponse {
            status: 206,
            version: "HTTP/1.1".into(),
            headers: original_headers.clone(),
            body: b"old".to_vec().into(),
            timestamp_ms: 0,
        };

        assert_eq!(
            rs.apply_response(&req("GET", "https", "x", "/"), &mut resp),
            None
        );
        assert_eq!(resp.body, b"old".as_slice());
        assert_eq!(resp.headers, original_headers);
    }

    #[test]
    fn response_body_rewrite_skips_encoded_partial_content_even_at_equal_decoded_length() {
        use std::io::Write;

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"old").unwrap();
        let gzip_body = encoder.finish().unwrap();
        let original_headers = vec![
            (
                "Content-Range".into(),
                format!("bytes 0-{}/{}", gzip_body.len() - 1, gzip_body.len()),
            ),
            ("Content-Encoding".into(), "gzip".into()),
        ];
        let rules = vec![Rule {
            id: "1".into(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher::default(),
            action: Action::RewriteResponseBody {
                find: "old".into(),
                replace: "new".into(),
                regex: false,
            },
        }];
        let mut resp = CapturedResponse {
            status: 206,
            version: "HTTP/1.1".into(),
            headers: original_headers.clone(),
            body: gzip_body.clone().into(),
            timestamp_ms: 0,
        };
        let mut cursors = RuleCursors::default();

        assert_eq!(
            apply_response_rules_stateful(
                &rules,
                &req("GET", "https", "x", "/"),
                &mut resp,
                &mut cursors,
            ),
            None
        );
        assert_eq!(resp.body, gzip_body);
        assert_eq!(resp.headers, original_headers);
        assert!(cursors.allows_fire(&rules[0]));
    }

    #[test]
    fn response_body_rewrite_noop_when_find_absent() {
        use std::io::Write;
        // The find string never occurs, so the rewrite must be a true no-op: no
        // match reported, body + Content-Encoding untouched, and the one-shot fire
        // budget intact (the bug reported a fire and stripped the encoding anyway).
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"nothing to redact here").unwrap();
        let gz = enc.finish().unwrap();

        let rules = vec![Rule {
            id: "1".into(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher::default(),
            action: Action::RewriteResponseBody {
                find: "secret".into(),
                replace: "public".into(),
                regex: false,
            },
        }];
        let mut resp = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("Content-Encoding".into(), "gzip".into())],
            body: gz.clone().into(),
            timestamp_ms: 0,
        };
        let mut cursors = RuleCursors::default();
        let matched = apply_response_rules_stateful(
            &rules,
            &req("GET", "https", "x", "/"),
            &mut resp,
            &mut cursors,
        );
        assert_eq!(matched, None, "a find that doesn't occur is not a match");
        assert_eq!(resp.body, gz, "the body is left byte-for-byte untouched");
        assert!(
            resp.headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
            "Content-Encoding must NOT be stripped when nothing changed"
        );
        assert!(
            cursors.allows_fire(&rules[0]),
            "a no-op rewrite must not burn the one-shot fire limit"
        );
    }

    #[test]
    fn response_body_rewrite_refuses_literal_amplification_past_cap() {
        assert_eq!(
            rewrite_text_capped("abcd", "", "xx", false, 12),
            None,
            "five empty matches would expand the four-byte input to fourteen bytes"
        );
        assert_eq!(
            rewrite_text_capped("aaaa", "a", "bb", false, 8).as_deref(),
            Some("bbbbbbbb")
        );
    }

    #[test]
    fn response_body_rewrite_refuses_regex_amplification_past_cap() {
        assert_eq!(rewrite_text_capped("aaaa", "a", "bbb", true, 11), None);
        assert_eq!(
            rewrite_text_capped("ab12", r"(\d+)", "[$1]", true, 6).as_deref(),
            Some("ab[12]")
        );
    }

    #[test]
    fn replacement_length_matches_regex_expansion_syntax() {
        let re = Regex::new(r"(?P<word>[a-z]+)-(\d+)").unwrap();
        let captures = re.captures("abc-42").unwrap();
        for replacement in [
            "$0/$word/$2",
            "${word}-$$-${99}",
            "$missing!",
            "trailing $",
            "${word",
        ] {
            let mut expanded = String::new();
            captures.expand(replacement, &mut expanded);
            assert_eq!(
                expanded_replacement_len(&captures, replacement),
                Some(expanded.len()),
                "{replacement}"
            );
        }
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
            general_active: true,
        };
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { rule_id, .. } => assert_eq!(rule_id, "from-b"),
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
            general_active: true,
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
            seq: 0,
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://x/api".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: bytes::Bytes::new(),
                timestamp_ms: 0,
            },
            response: Some(CapturedResponse {
                status: 201,
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("ETag".into(), "\"captured\"".into()),
                    ("Content-Digest".into(), "sha-256=:stale:".into()),
                    ("Content-Range".into(), "bytes 0-6/100".into()),
                    ("X-Keep".into(), "yes".into()),
                ],
                body: b"{\"a\":1}".to_vec().into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "r1".into());
        assert_eq!(rule.matcher.method.as_deref(), Some("GET"));
        assert_eq!(rule.matcher.url, "https://x/api");
        assert_eq!(rule.label(), "https://x/api");
        match rule.action {
            Action::Respond {
                status,
                body,
                content_type,
                headers,
                ..
            } => {
                assert_eq!(status, 201);
                assert_eq!(body, "{\"a\":1}");
                assert_eq!(content_type.as_deref(), Some("application/json"));
                assert_eq!(headers, vec![("X-Keep".into(), "yes".into())]);
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn rule_from_flow_uses_full_url() {
        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: CapturedRequest {
                method: "POST".into(),
                uri: "https://x/api/v2/rum?dd=1&k=abc".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api/v2/rum?dd=1&k=abc".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: bytes::Bytes::new(),
                timestamp_ms: 0,
            },
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        // Host-specific full URL preserved (no collapsing) — one rule per request.
        let rule = respond_rule_from_flow(&flow, "r".into());
        assert_eq!(rule.matcher.url, "https://x/api/v2/rum?dd=1&k=abc");
        assert_eq!(rule.matcher.url_match, MatchKind::Exact);
        assert_eq!(rule.label(), "https://x/api/v2/rum?dd=1&k=abc");
    }

    #[test]
    fn empty_matcher_rule_labels_as_star() {
        // Issue #74: rules are unnamed; a match-all (empty-URL) rule falls back
        // to "*" as its display/provenance label.
        let rule = blank_rule("id".into());
        assert_eq!(rule.matcher.url, "");
        assert_eq!(rule.label(), "*");
    }

    #[test]
    fn blank_rule_matches_every_request() {
        // A freshly-created rule (empty URL) must match, so a hand-written rule
        // fires without the user first filling in a URL. Its default match kind
        // is Contains — Exact with an empty URL would silently match nothing.
        let rule = blank_rule("id".into());
        assert_eq!(rule.matcher.url_match, MatchKind::Contains);
        assert!(rule
            .matcher
            .matches(&req("GET", "https", "api.example.com", "/users?page=1")));
        assert!(rule
            .matcher
            .matches(&req("POST", "http", "other.test", "/")));
    }

    #[test]
    fn two_rules_can_share_a_url() {
        // Issue #74: rules are keyed by id, not URL, so several rules may target
        // the same URL. Both keep that URL as their label; ids stay distinct.
        let a = respond_rule("a", "https://x/api");
        let b = respond_rule("b", "https://x/api");
        assert_ne!(a.id, b.id);
        assert_eq!(a.label(), b.label());
        assert_eq!(a.label(), "https://x/api");

        let ar = AutoResponder {
            scenarios: vec![Scenario {
                id: "s".into(),
                name: "S".into(),
                rules: vec![a, b],
            }],
            active_scenario_id: Some("s".into()),
            general_active: true,
        };
        assert_eq!(ar.scenarios[0].rules.len(), 2);
        let outcome = ar.evaluate_request(&req("GET", "https", "x", "/api"));
        assert_eq!(
            responded_rule_id(&outcome),
            Some("a"),
            "first matching rule wins"
        );
    }

    #[test]
    fn rule_from_flow_decodes_gzipped_body_and_seeds_encoding() {
        use std::io::Write;
        // A captured gzip response: the seeded rule must store the DECODED body
        // (readable in the editor) and carry content_encoding=gzip so the engine
        // re-compresses on serve. Before this fix the raw gzip bytes were
        // lossy-UTF-8'd into the body and the encoding was dropped, producing a
        // corrupt non-gzip non-JSON response on the wire.
        let original = br#"{"ok":true,"items":[1,2,3]}"#;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(original).unwrap();
        let gz = enc.finish().unwrap();

        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://x/api".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: bytes::Bytes::new(),
                timestamp_ms: 0,
            },
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("Content-Encoding".into(), "gzip".into()),
                ],
                body: gz.into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };

        let rule = respond_rule_from_flow(&flow, "r".into());
        match &rule.action {
            Action::Respond {
                body,
                content_encoding,
                ..
            } => {
                assert_eq!(
                    body.as_bytes(),
                    original,
                    "seeded body must be the decoded text"
                );
                assert_eq!(
                    content_encoding.as_deref(),
                    Some("gzip"),
                    "the original encoding must be preserved as the serve-time toggle",
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }

        // End-to-end: when the rule fires, the engine must re-compress and stamp
        // the content-encoding header, so a client receives a valid gzip stream
        // that decodes back to the original body.
        let rules = vec![rule];
        let outcome = evaluate_request_rules(&rules, &req("GET", "https", "x", "/api"));
        match outcome {
            RequestOutcome::Respond { response, .. } => {
                let has_enc = response
                    .headers
                    .iter()
                    .any(|(k, v)| k.eq_ignore_ascii_case("content-encoding") && v == "gzip");
                assert!(has_enc, "served response must carry content-encoding: gzip");
                let decoded = crate::body::try_decompress("gzip", &response.body)
                    .expect("served body must be a valid gzip stream");
                assert_eq!(
                    decoded,
                    original.to_vec(),
                    "wire body decodes to the original"
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn rule_from_flow_keeps_encoding_for_pre_decoded_textual_body() {
        // HAR/SAZ importers decompress the body but KEEP the Content-Encoding
        // header. The body is already decoded text, decode_body fails (it's not
        // gzip), but looks_textual passes — so the rule must keep the body as-is
        // AND keep the encoding toggle, so the engine re-compresses on serve
        // and the wire matches the original response.
        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://x/api".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: bytes::Bytes::new(),
                timestamp_ms: 0,
            },
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("Content-Encoding".into(), "gzip".into()),
                ],
                body: b"{\"ok\":true}".to_vec().into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "r".into());
        match rule.action {
            Action::Respond {
                body,
                content_encoding,
                ..
            } => {
                assert_eq!(body, "{\"ok\":true}");
                assert_eq!(
                    content_encoding.as_deref(),
                    Some("gzip"),
                    "a pre-decoded textual body must keep the encoding toggle so the engine re-compresses on serve",
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn rule_from_flow_drops_a_chained_encoding_the_single_toggle_cannot_reproduce() {
        use std::io::Write;

        let original = b"chained response";
        let mut deflate =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        deflate.write_all(original).unwrap();
        let deflated = deflate.finish().unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&deflated).unwrap();
        let encoded = gzip.finish().unwrap();

        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: req("GET", "https", "x", "/api"),
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![("Content-Encoding".into(), "deflate, gzip".into())],
                body: encoded.into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };

        let rule = respond_rule_from_flow(&flow, "r".into());
        match rule.action {
            Action::Respond {
                body,
                content_encoding,
                ..
            } => {
                assert_eq!(body.as_bytes(), original);
                assert_eq!(content_encoding, None);
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn rule_from_flow_drops_encoding_for_undecodable_binary() {
        // A genuinely binary body that declares gzip but can't be decoded (corrupt
        // gzip stream or a stale header on binary content): decode_body fails AND
        // looks_textual fails → drop the encoding toggle, serve raw bytes as
        // identity. Forwarding undecodable binary labeled gzip would corrupt the
        // response.
        let binary: Vec<u8> = [0x00, 0xff, 0xfe, 0x80, 0x9c, 0x01, 0x02, 0x88].repeat(20);
        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://x/api".into(),
                scheme: "https".into(),
                host: "x".into(),
                path: "/api".into(),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: bytes::Bytes::new(),
                timestamp_ms: 0,
            },
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Content-Type".into(), "application/octet-stream".into()),
                    ("Content-Encoding".into(), "gzip".into()),
                ],
                body: binary.clone().into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "r".into());
        match rule.action {
            Action::Respond {
                content_encoding, ..
            } => {
                assert_eq!(
                    content_encoding, None,
                    "an undecodable binary body must not keep the encoding toggle",
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn serve_encodes_respond_body_when_toggle_set() {
        // A hand-authored rule with content_encoding=gzip: the engine compresses
        // the (decoded) body on the wire and stamps the header. Identity toggle
        // (None) sends raw bytes with no encoding header, as before.
        let gzip_rule = Rule {
            id: "gz".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/g".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: "{\"mocked\":true}".to_string(),
                body_base64: None,
                content_type: Some("application/json".to_string()),
                content_encoding: Some("gzip".to_string()),
            },
        };
        let identity_rule = Rule {
            id: "id".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/i".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: "{\"mocked\":true}".to_string(),
                body_base64: None,
                content_type: Some("application/json".to_string()),
                content_encoding: None,
            },
        };

        // gzip rule → compressed wire body + header.
        let gz_outcome = evaluate_request_rules(&[gzip_rule], &req("GET", "https", "h", "/g"));
        match gz_outcome {
            RequestOutcome::Respond { response, .. } => {
                assert!(
                    response
                        .headers
                        .iter()
                        .any(|(k, v)| k.eq_ignore_ascii_case("content-encoding") && v == "gzip"),
                    "gzip toggle must stamp content-encoding: gzip",
                );
                assert_ne!(
                    response.body,
                    b"{\"mocked\":true}".as_slice(),
                    "wire body must be compressed, not the raw text",
                );
                let decoded = crate::body::try_decompress("gzip", &response.body)
                    .expect("wire body must be a valid gzip stream");
                assert_eq!(decoded, b"{\"mocked\":true}");
            }
            other => panic!("expected Respond, got {other:?}"),
        }

        // identity rule → raw body, no encoding header.
        let id_outcome = evaluate_request_rules(&[identity_rule], &req("GET", "https", "h", "/i"));
        match id_outcome {
            RequestOutcome::Respond { response, .. } => {
                assert!(
                    !response
                        .headers
                        .iter()
                        .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
                    "identity toggle must not stamp content-encoding",
                );
                assert_eq!(response.body, b"{\"mocked\":true}".as_slice());
            }
            other => panic!("expected Respond, got {other:?}"),
        }
    }

    #[test]
    fn serve_falls_back_to_identity_for_unknown_encoding() {
        // A toggle value the engine can't compress (typo / unsupported): fall
        // back to identity bytes with NO encoding header, rather than emitting a
        // corrupt response labeled with an encoding it doesn't have.
        let rule = Rule {
            id: "x".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/x".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![
                    ("Content-Encoding".into(), "gzip".into()),
                    ("Content-Type".into(), "application/stale".into()),
                ],
                body: "hello".to_string(),
                body_base64: None,
                content_type: Some("text/plain".to_string()),
                content_encoding: Some("snappy".to_string()),
            },
        };
        match evaluate_request_rules(&[rule], &req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { response, .. } => {
                assert!(
                    !response
                        .headers
                        .iter()
                        .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
                    "unsupported encoding must not stamp a content-encoding header",
                );
                assert_eq!(
                    response.body,
                    b"hello".as_slice(),
                    "body is sent as identity bytes"
                );
                assert_eq!(
                    response
                        .headers
                        .iter()
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                        .map(|(_, value)| value.as_str())
                        .collect::<Vec<_>>(),
                    vec!["text/plain"],
                    "the dedicated content type replaces free-form stale copies"
                );
            }
            other => panic!("expected Respond, got {other:?}"),
        }
        assert_eq!(normalize_encoding(Some("gzip, br")), None);
        assert_eq!(normalize_encoding(Some("notgzip")), None);
        assert_eq!(normalize_encoding(Some("x-gzip")), Some("gzip".into()));
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
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        };
        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: req("github.com", "/feed"),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "r".into());

        // Mocking github.com/feed must NOT also catch a different host's /feed.
        assert!(rule.matcher.matches(&req("github.com", "/feed")));
        assert!(!rule.matcher.matches(&req("dynatrace.com", "/feed")));
    }

    #[test]
    fn mock_rule_is_exact_not_substring() {
        let flow = Flow {
            id: "f".into(),
            seq: 0,
            request: req("GET", "https", "google.com", "/"),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "r".into());

        assert_eq!(rule.matcher.url_match, MatchKind::Exact);
        assert!(rule
            .matcher
            .matches(&req("GET", "https", "google.com", "/")));
        assert!(!rule
            .matcher
            .matches(&req("GET", "https", "google.com", "/api/data")));
        assert!(!rule
            .matcher
            .matches(&req("GET", "https", "google.com", "/index.html")));
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
            responded_rule_id(&first),
            Some("a"),
            "first request must hit the match-once rule A"
        );
        let second = evaluate_request_rules_stateful(&rules, &r(), &mut cursors);
        assert_eq!(
            responded_rule_id(&second),
            Some("b"),
            "after A is consumed the same URL must fall through to B"
        );
        let third = evaluate_request_rules_stateful(&rules, &r(), &mut cursors);
        assert_eq!(
            responded_rule_id(&third),
            Some("b"),
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
                body_base64: None,
                content_type: None,
                content_encoding: None,
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
                responded_rule_id(&evaluate_request_rules_stateful(
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

        let repeat_zero = vec![respond_rule_limited(
            "never-loop",
            "/zeroloop",
            Some(0),
            true,
        )];
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
    fn maplocal_read_is_hard_capped_even_when_metadata_was_acceptable() {
        let path = std::env::temp_dir().join(format!(
            "germi-maplocal-cap-{}-{}",
            std::process::id(),
            crate::flow::now_ms()
        ));
        std::fs::write(&path, b"12345").expect("write fixture");
        assert_eq!(
            read_map_local_capped(path.to_str().expect("utf8 temp path"), 5),
            Some(b"12345".to_vec())
        );
        assert_eq!(
            read_map_local_capped(path.to_str().expect("utf8 temp path"), 4),
            None
        );
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn set_request_header_honors_one_shot_fire_limit() {
        let rules = vec![Rule {
            id: "hdr".into(),
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

        match evaluate_request_rules_stateful(&rules, &r(), &mut cursors) {
            RequestOutcome::Continue { set_headers } => {
                assert_eq!(set_headers, vec![("x-germi".to_string(), "1".to_string())]);
            }
            other => panic!("expected Continue with header, got {other:?}"),
        }
        assert!(matches!(
            evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
            RequestOutcome::Continue { set_headers } if set_headers.is_empty()
        ));
        assert_eq!(
            cursors.snapshot().get("hdr").copied().unwrap_or(0),
            1,
            "a pass-through request edit spends its configured fire budget"
        );
    }

    #[test]
    fn invalid_request_header_rule_is_a_noop_and_does_not_spend_its_limit() {
        let mut rule = respond_rule_limited("hdr", "/h", Some(1), false);
        rule.action = Action::SetRequestHeader {
            name: "bad header".into(),
            value: "value".into(),
        };
        let mut cursors = RuleCursors::default();

        assert!(matches!(
            evaluate_request_rules_stateful(
                std::slice::from_ref(&rule),
                &req("GET", "https", "h", "/h"),
                &mut cursors,
            ),
            RequestOutcome::Continue { set_headers } if set_headers.is_empty()
        ));
        assert!(cursors.snapshot().is_empty());
    }

    #[test]
    fn repeating_request_header_fires_once_per_request() {
        let mut rule = respond_rule_limited("hdr", "/h", Some(1), true);
        rule.action = Action::SetRequestHeader {
            name: "x-germi".into(),
            value: "1".into(),
        };
        let mut cursors = RuleCursors::default();
        for _ in 0..3 {
            assert!(matches!(
                evaluate_request_rules_stateful(
                    std::slice::from_ref(&rule),
                    &req("GET", "https", "h", "/h"),
                    &mut cursors,
                ),
                RequestOutcome::Continue { set_headers }
                    if set_headers == vec![("x-germi".to_string(), "1".to_string())]
            ));
        }
    }

    #[test]
    fn unrelated_request_header_does_not_starve_repeating_mock() {
        let mut header = respond_rule_limited("header", "/h", None, false);
        header.action = Action::SetRequestHeader {
            name: "x-germi".into(),
            value: "1".into(),
        };
        let mock = respond_rule_limited("mock", "/h", Some(1), true);
        let rules = vec![header, mock];
        let mut cursors = RuleCursors::default();

        for request_number in 1..=3 {
            assert_eq!(
                responded_rule_id(&evaluate_request_rules_stateful(
                    &rules,
                    &req("GET", "https", "h", "/h"),
                    &mut cursors,
                )),
                Some("mock"),
                "request {request_number}: the unlimited header must not prevent the mock cycle from resetting"
            );
        }
    }

    #[test]
    fn response_header_replacement_removes_case_insensitive_duplicates() {
        let rules = vec![Rule {
            id: "header".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::SetResponseHeader {
                name: "X-Test".into(),
                value: "new".into(),
            },
        }];
        let mut response = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![
                ("x-test".into(), "old-a".into()),
                ("content-type".into(), "text/plain".into()),
                ("X-TEST".into(), "old-b".into()),
            ],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        };
        apply_response_rules(&rules, &req("GET", "https", "h", "/"), &mut response);
        let matching: Vec<_> = response
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("x-test"))
            .collect();
        assert_eq!(matching, vec![&("X-Test".to_string(), "new".to_string())]);
    }

    #[test]
    fn invalid_response_header_rule_preserves_the_response_and_fire_limit() {
        let mut rule = respond_rule_limited("header", "/", Some(1), false);
        rule.action = Action::SetResponseHeader {
            name: "x-test".into(),
            value: "bad\nvalue".into(),
        };
        let mut response = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("x-test".into(), "original".into())],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        };
        let mut cursors = RuleCursors::default();

        let matched = apply_response_rules_stateful(
            std::slice::from_ref(&rule),
            &req("GET", "https", "h", "/"),
            &mut response,
            &mut cursors,
        );
        assert!(matched.is_none());
        assert_eq!(response.headers, vec![("x-test".into(), "original".into())]);
        assert!(cursors.snapshot().is_empty());
    }

    #[test]
    fn binary_capture_mock_replays_exact_bytes() {
        let binary = vec![0x00, 0xff, 0xfe, 0x80, 0x41, 0x00, 0x9c];
        let flow = Flow {
            id: "binary".into(),
            seq: 1,
            request: req("GET", "https", "example.test:8443", "/asset"),
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![("content-type".into(), "application/octet-stream".into())],
                body: binary.clone().into(),
                timestamp_ms: 0,
            }),
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        };
        let rule = respond_rule_from_flow(&flow, "mock".into());
        assert_eq!(rule.matcher.url, "https://example.test:8443/asset");
        assert!(matches!(
            &rule.action,
            Action::Respond {
                body_base64: Some(_),
                ..
            }
        ));
        match evaluate_request_rules(&[rule], &flow.request) {
            RequestOutcome::Respond { response, .. } => assert_eq!(response.body.as_ref(), binary),
            other => panic!("expected binary Respond, got {other:?}"),
        }
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
            general_active: true,
        };
        let mut cursors = RuleCursors::default();

        match ar.evaluate_request_stateful(&req("GET", "https", "h", "/x"), &mut cursors) {
            RequestOutcome::Respond { rule_id, .. } => assert_eq!(rule_id, "from-b"),
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
    fn rule_hit_counters_saturate_instead_of_wrapping_or_panicking() {
        let rule = respond_rule("max", "/max");
        let mut cursors = RuleCursors::default();
        cursors.restore(HashMap::from([(rule.id.clone(), u32::MAX)]));
        cursors.record_fire(&rule);
        assert_eq!(cursors.snapshot().get(&rule.id), Some(&u32::MAX));
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
            general_active: true,
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

    #[test]
    fn repeat_sibling_does_not_revive_non_repeat_rule() {
        // A one-shot rule sharing a URL with a repeat rule must fire exactly
        // once; only the repeat rule loops when the group resets.
        let mut once = respond_rule_limited("once", "/dup", Some(1), false);
        once.id = "once".into();
        let mut looping = respond_rule_limited("loop", "/dup", Some(1), true);
        looping.id = "loop".into();
        let rules = vec![once, looping];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/dup");

        let order: Vec<Option<String>> = (0..5)
            .map(|_| {
                responded_rule_id(&evaluate_request_rules_stateful(&rules, &r(), &mut cursors))
                    .map(str::to_string)
            })
            .collect();
        assert_eq!(
            order,
            vec![
                Some("once".to_string()),
                Some("loop".to_string()),
                Some("loop".to_string()),
                Some("loop".to_string()),
                Some("loop".to_string()),
            ],
            "the one-shot fires once; only the repeat rule loops"
        );
        assert_eq!(
            cursors.snapshot().get("once").copied(),
            Some(1),
            "the non-repeat one-shot must record exactly one fire"
        );
    }

    #[test]
    fn dead_repeat_zero_does_not_revive_sibling() {
        // A repeat rule that can never fire (limit 0) is not a looping group, so
        // it must not reset a sibling one-shot's cursor every request.
        let mut dead = respond_rule_limited("dead", "/z", Some(0), true);
        dead.id = "dead".into();
        let mut once = respond_rule_limited("once", "/z", Some(1), false);
        once.id = "once".into();
        let rules = vec![dead, once];
        let mut cursors = RuleCursors::default();
        let r = || req("GET", "https", "h", "/z");

        assert_eq!(
            responded_rule_id(&evaluate_request_rules_stateful(&rules, &r(), &mut cursors)),
            Some("once"),
            "first request: the one-shot fires"
        );
        for _ in 0..3 {
            assert!(
                matches!(
                    evaluate_request_rules_stateful(&rules, &r(), &mut cursors),
                    RequestOutcome::Continue { .. }
                ),
                "a dead (limit 0) repeat sibling must not revive the spent one-shot"
            );
        }
    }

    #[test]
    fn unavailable_repeat_sibling_does_not_starve_spent_mock() {
        let mut header = respond_rule_limited("header", "/loop", None, false);
        header.id = "header".into();
        header.action = Action::SetRequestHeader {
            name: "x-pass".into(),
            value: "yes".into(),
        };

        let mut missing = respond_rule_limited("missing", "/loop", Some(1), true);
        missing.id = "missing".into();
        missing.action = Action::MapLocal {
            path: "/path/that/does/not/exist/germi-repeat".into(),
            status: 200,
        };

        let mut looping = respond_rule_limited("looping", "/loop", Some(1), true);
        looping.id = "looping".into();
        let rules = vec![header, missing, looping];
        let mut cursors = RuleCursors::default();
        let request = || req("GET", "https", "h", "/loop");

        for _ in 0..4 {
            assert_eq!(
                responded_rule_id(&evaluate_request_rules_stateful(
                    &rules,
                    &request(),
                    &mut cursors
                )),
                Some("looping"),
                "a skipped repeat sibling must not block the usable mock from cycling"
            );
        }
    }

    fn set_status_rule(id: &str, status: u16, limit: Option<u32>, repeat: bool) -> Rule {
        Rule {
            id: id.into(),
            enabled: true,
            fire_limit: limit,
            repeat,
            matcher: Matcher {
                method: None,
                url: "/r".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::SetStatus { status },
        }
    }

    fn resp() -> CapturedResponse {
        CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        }
    }

    #[test]
    fn response_rule_honors_fire_limit() {
        let rules = vec![set_status_rule("once", 503, Some(1), false)];
        let mut cursors = RuleCursors::default();
        let r = req("GET", "https", "h", "/r");

        let mut a = resp();
        assert_eq!(
            apply_response_rules_stateful(&rules, &r, &mut a, &mut cursors).as_deref(),
            Some("/r")
        );
        assert_eq!(a.status, 503, "first matching response is overridden");

        let mut b = resp();
        assert_eq!(
            apply_response_rules_stateful(&rules, &r, &mut b, &mut cursors),
            None,
            "a spent one-shot response rule must not fire again"
        );
        assert_eq!(b.status, 200, "second response is left untouched");
    }

    #[test]
    fn response_rule_repeat_loops() {
        let rules = vec![set_status_rule("loop", 503, Some(1), true)];
        let mut cursors = RuleCursors::default();
        let r = req("GET", "https", "h", "/r");

        for _ in 0..4 {
            let mut resp = resp();
            assert_eq!(
                apply_response_rules_stateful(&rules, &r, &mut resp, &mut cursors).as_deref(),
                Some("/r"),
                "a repeat response rule keeps firing"
            );
            assert_eq!(resp.status, 503);
        }
    }

    #[test]
    fn response_apply_scratch_is_side_effect_free() {
        let rules = vec![set_status_rule("once", 503, Some(1), false)];
        let r = req("GET", "https", "h", "/r");
        for _ in 0..3 {
            let mut resp = resp();
            assert_eq!(
                apply_response_rules(&rules, &r, &mut resp).as_deref(),
                Some("/r"),
                "the scratch preview re-applies every call (no state)"
            );
        }
    }

    fn cors_rule(url: &str) -> Rule {
        Rule {
            id: "cors".into(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: url.into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Cors,
        }
    }

    fn req_h(method: &str, path: &str, headers: &[(&str, &str)]) -> CapturedRequest {
        let mut r = req(method, "https", "example.com", path);
        r.headers = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        r
    }

    #[test]
    fn cors_answers_matching_preflight() {
        let rules = vec![cors_rule("/api")];
        let outcome = evaluate_request_rules(
            &rules,
            &req_h(
                "OPTIONS",
                "/api/users",
                &[
                    ("origin", "http://localhost:3000"),
                    ("access-control-request-method", "POST"),
                    (
                        "access-control-request-headers",
                        "authorization, content-type",
                    ),
                ],
            ),
        );
        let RequestOutcome::Respond { response, .. } = outcome else {
            panic!("a matching preflight must be answered");
        };
        assert_eq!(response.status, 204);
        assert!(response.body.is_empty());
        assert_eq!(
            header(&response.headers, "access-control-allow-origin"),
            Some("http://localhost:3000"),
            "the Origin is echoed, never `*`"
        );
        assert_eq!(
            header(&response.headers, "access-control-allow-methods"),
            Some("POST")
        );
        assert_eq!(
            header(&response.headers, "access-control-allow-headers"),
            Some("authorization, content-type")
        );
        assert_eq!(
            header(&response.headers, "access-control-allow-credentials"),
            Some("true")
        );
        assert!(header(&response.headers, "vary")
            .unwrap()
            .contains("Origin"));
    }

    #[test]
    fn cors_ignores_plain_options_and_other_urls() {
        let rules = vec![cors_rule("/api")];
        assert!(
            matches!(
                evaluate_request_rules(
                    &rules,
                    &req_h("OPTIONS", "/api/users", &[("origin", "http://a")])
                ),
                RequestOutcome::Continue { .. }
            ),
            "OPTIONS without Access-Control-Request-Method is not a preflight"
        );
        assert!(
            matches!(
                evaluate_request_rules(
                    &rules,
                    &req_h(
                        "OPTIONS",
                        "/other",
                        &[
                            ("origin", "http://a"),
                            ("access-control-request-method", "GET"),
                        ]
                    )
                ),
                RequestOutcome::Continue { .. }
            ),
            "a preflight outside the matcher passes through"
        );
    }

    #[test]
    fn cors_stamps_matching_response() {
        let rules = vec![cors_rule("/api")];
        let r = req_h("GET", "/api/users", &[("origin", "http://localhost:3000")]);
        let mut response = resp();
        response.headers = vec![
            ("content-type".into(), "application/json".into()),
            ("x-total-count".into(), "42".into()),
            ("content-encoding".into(), "gzip".into()),
            ("set-cookie".into(), "sid=1".into()),
            (
                "access-control-expose-headers".into(),
                "X-Virtual, X-Total-Count".into(),
            ),
            ("access-control-allow-origin".into(), "*".into()),
            (
                "Access-Control-Allow-Origin".into(),
                "https://stale.example".into(),
            ),
        ];
        assert!(apply_response_rules(&rules, &r, &mut response).is_some());
        assert_eq!(
            header(&response.headers, "access-control-allow-origin"),
            Some("http://localhost:3000"),
            "the echo overwrites a stale value — `*` breaks credentialed requests"
        );
        assert_eq!(
            response
                .headers
                .iter()
                .filter(|(name, _)| name.eq_ignore_ascii_case("access-control-allow-origin"))
                .count(),
            1,
            "forcing CORS must remove duplicate singleton headers"
        );
        assert_eq!(
            header(&response.headers, "access-control-allow-credentials"),
            Some("true")
        );
        assert_eq!(
            header(&response.headers, "access-control-expose-headers"),
            Some("X-Virtual, X-Total-Count, content-encoding"),
            "preserves upstream names and derives actual non-safelisted headers"
        );
        assert_eq!(header(&response.headers, "vary"), Some("Origin"));
    }

    #[test]
    fn cors_leaves_non_cors_traffic_untouched() {
        let rules = vec![cors_rule("")];
        let r = req("GET", "https", "api.test", "/api/users");
        let mut response = resp();
        assert_eq!(
            apply_response_rules(&rules, &r, &mut response),
            None,
            "no Origin header means no CORS to fix"
        );
        assert!(response.headers.is_empty());
    }

    #[test]
    fn cors_appends_origin_to_existing_vary() {
        let rules = vec![cors_rule("")];
        let r = req_h("GET", "/x", &[("origin", "http://a")]);
        let mut response = resp();
        response.headers = vec![("vary".into(), "Accept-Encoding".into())];
        apply_response_rules(&rules, &r, &mut response);
        assert_eq!(
            header(&response.headers, "vary"),
            Some("Accept-Encoding, Origin")
        );

        let mut star = resp();
        star.headers = vec![("vary".into(), "*".into())];
        apply_response_rules(&rules, &r, &mut star);
        assert_eq!(header(&star.headers, "vary"), Some("*"));
    }

    #[test]
    fn cors_preflight_spares_the_mock_fire_budget() {
        let mock = Rule {
            id: "mock".into(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/api".into(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: "{}".into(),
                body_base64: None,
                content_type: None,
                content_encoding: None,
            },
        };
        let rules = vec![cors_rule("/api"), mock];
        let mut cursors = RuleCursors::default();

        let preflight = req_h(
            "OPTIONS",
            "/api/users",
            &[
                ("origin", "http://a"),
                ("access-control-request-method", "GET"),
            ],
        );
        let RequestOutcome::Respond { rule_id, .. } =
            evaluate_request_rules_stateful(&rules, &preflight, &mut cursors)
        else {
            panic!("the preflight must be answered");
        };
        assert_eq!(rule_id, "cors", "the Cors rule above answers the preflight");

        let real = req_h("GET", "/api/users", &[("origin", "http://a")]);
        let RequestOutcome::Respond { rule_id, .. } =
            evaluate_request_rules_stateful(&rules, &real, &mut cursors)
        else {
            panic!("the mock must still fire");
        };
        assert_eq!(rule_id, "mock", "the one-shot mock's budget was not burned");
    }

    #[test]
    fn cors_skips_response_phase_for_preflights() {
        let rules = vec![cors_rule("")];
        let preflight = req_h(
            "OPTIONS",
            "/api",
            &[
                ("origin", "http://a"),
                ("access-control-request-method", "GET"),
            ],
        );
        let mut response = resp();
        assert_eq!(
            apply_response_rules(&rules, &preflight, &mut response),
            None,
            "the request phase already answered — no double fire"
        );
    }

    // ---- General layer stacking ----

    fn resp_header_rule(id: &str, url: &str, name: &str, value: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: url.to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::SetResponseHeader {
                name: name.to_string(),
                value: value.to_string(),
            },
        }
    }

    fn req_header_rule(id: &str, url: &str, name: &str, value: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: url.to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::SetRequestHeader {
                name: name.to_string(),
                value: value.to_string(),
            },
        }
    }

    fn general_scenario(rules: Vec<Rule>) -> Scenario {
        Scenario {
            id: GENERAL_SCENARIO_ID.to_string(),
            name: GENERAL_SCENARIO_NAME.to_string(),
            rules,
        }
    }

    fn user_scenario(id: &str, rules: Vec<Rule>) -> Scenario {
        Scenario {
            id: id.to_string(),
            name: id.to_string(),
            rules,
        }
    }

    fn ar_with(
        general: Vec<Rule>,
        active: Option<(&str, Vec<Rule>)>,
        general_active: bool,
    ) -> AutoResponder {
        let mut scenarios = vec![general_scenario(general)];
        let active_id = active.as_ref().map(|(id, _)| (*id).to_string());
        if let Some((id, rules)) = active {
            scenarios.push(user_scenario(id, rules));
        }
        AutoResponder {
            scenarios,
            active_scenario_id: active_id,
            general_active,
        }
    }

    #[test]
    fn general_respond_wins_before_active() {
        let ar = ar_with(
            vec![respond_rule("general-mock", "/x")],
            Some(("A", vec![respond_rule("active-mock", "/x")])),
            true,
        );
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { rule_id, .. } => {
                assert_eq!(
                    rule_id, "general-mock",
                    "the General layer is evaluated first"
                );
            }
            other => panic!("expected a General respond, got {other:?}"),
        }
    }

    #[test]
    fn general_off_lets_active_respond() {
        let ar = ar_with(
            vec![respond_rule("general-mock", "/x")],
            Some(("A", vec![respond_rule("active-mock", "/x")])),
            false,
        );
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { rule_id, .. } => {
                assert_eq!(rule_id, "active-mock", "General off ⇒ its rules never fire");
            }
            other => panic!("expected the active respond, got {other:?}"),
        }
    }

    #[test]
    fn general_and_active_request_headers_merge() {
        let ar = ar_with(
            vec![req_header_rule("g", "/x", "x-general", "1")],
            Some(("A", vec![req_header_rule("a", "/x", "x-active", "2")])),
            true,
        );
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Continue { set_headers } => {
                assert!(set_headers
                    .iter()
                    .any(|(k, v)| k == "x-general" && v == "1"));
                assert!(set_headers.iter().any(|(k, v)| k == "x-active" && v == "2"));
            }
            other => panic!("expected Continue with merged headers, got {other:?}"),
        }
    }

    #[test]
    fn general_request_headers_survive_active_short_circuit() {
        let ar = ar_with(
            vec![req_header_rule("g", "/x", "x-general", "1")],
            Some(("A", vec![respond_rule("active-mock", "/x")])),
            true,
        );

        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond {
                rule_id,
                set_headers,
                ..
            } => {
                assert_eq!(rule_id, "active-mock");
                assert_eq!(
                    set_headers,
                    vec![("x-general".to_string(), "1".to_string())],
                    "a mock must retain request edits accumulated in General"
                );
            }
            other => panic!("expected active Respond with General headers, got {other:?}"),
        }
    }

    #[test]
    fn general_and_active_response_rules_both_apply() {
        let ar = ar_with(
            vec![resp_header_rule("g", "/x", "x-general", "1")],
            Some(("A", vec![resp_header_rule("a", "/x", "x-active", "2")])),
            true,
        );
        let mut response = resp();
        let fired = ar.apply_response(&req("GET", "https", "h", "/x"), &mut response);
        assert!(fired.is_some(), "at least one layer changed the response");
        assert!(response
            .headers
            .iter()
            .any(|(k, v)| k == "x-general" && v == "1"));
        assert!(response
            .headers
            .iter()
            .any(|(k, v)| k == "x-active" && v == "2"));
    }

    #[test]
    fn general_applies_when_active_is_off() {
        let ar = ar_with(
            vec![resp_header_rule("g", "/x", "x-general", "1")],
            None,
            true,
        );
        let mut response = resp();
        assert_eq!(
            ar.apply_response(&req("GET", "https", "h", "/x"), &mut response)
                .as_deref(),
            Some("/x"),
            "General response rules apply even when the active scenario is Off"
        );
        assert!(response
            .headers
            .iter()
            .any(|(k, v)| k == "x-general" && v == "1"));
    }

    #[test]
    fn evaluated_rule_ids_span_general_and_active() {
        let ar = ar_with(
            vec![respond_rule("g1", "/x")],
            Some(("A", vec![respond_rule("a1", "/y")])),
            true,
        );
        let ids = ar.evaluated_rule_ids();
        assert!(ids.contains("g1") && ids.contains("a1"));

        let off = ar_with(
            vec![respond_rule("g1", "/x")],
            Some(("A", vec![respond_rule("a1", "/y")])),
            false,
        );
        let ids_off = off.evaluated_rule_ids();
        assert!(
            !ids_off.contains("g1"),
            "General off ⇒ its ids are not live"
        );
        assert!(ids_off.contains("a1"));
    }

    #[test]
    fn active_never_resolves_to_general() {
        let ar = AutoResponder {
            scenarios: vec![general_scenario(vec![respond_rule("g", "/x")])],
            active_scenario_id: Some(GENERAL_SCENARIO_ID.to_string()),
            general_active: true,
        };
        assert!(
            ar.active().is_none(),
            "General can never be the active scenario"
        );
    }

    #[test]
    fn ensure_general_seeds_first_and_normalizes_active() {
        let mut ar = AutoResponder {
            scenarios: vec![user_scenario("A", vec![])],
            active_scenario_id: Some(GENERAL_SCENARIO_ID.to_string()),
            general_active: true,
        };
        ar.ensure_general();
        assert_eq!(
            ar.scenarios[0].id, GENERAL_SCENARIO_ID,
            "General is seeded first"
        );
        assert_eq!(ar.scenarios.len(), 2);
        assert_eq!(
            ar.active_scenario_id, None,
            "an active pointer aliasing General is cleared"
        );

        // Idempotent + relocates an out-of-place General to the front and
        // restores its fixed display name.
        ar.scenarios.swap(0, 1);
        ar.scenarios[1].name = "Renamed by an older build".to_string();
        ar.ensure_general();
        assert_eq!(ar.scenarios[0].id, GENERAL_SCENARIO_ID);
        assert_eq!(ar.scenarios[0].name, GENERAL_SCENARIO_NAME);
        assert_eq!(ar.scenarios.len(), 2, "no duplicate General is added");

        ar.active_scenario_id = Some("missing".to_string());
        ar.ensure_general();
        assert_eq!(
            ar.active_scenario_id, None,
            "a dangling persisted active pointer is normalized to Off"
        );
    }

    fn map_remote_rule(id: &str, pattern: &str, kind: MatchKind, target: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: None,
                url: pattern.to_string(),
                url_match: kind,
            },
            action: Action::MapRemote {
                url: target.to_string(),
            },
        }
    }

    #[test]
    fn map_remote_expands_regex_capture_groups() {
        // The motivating example from issue #111: point an agent script at a
        // local server, carrying the matched token over via $1 — including the
        // Fiddler-style `$1_1` form where `_1` is literal text, not part of
        // the group reference.
        let rules = vec![map_remote_rule(
            "m",
            r".*ruxitagentjs_(\w+)_\d+\.js",
            MatchKind::Regex,
            "http://localhost:8080/ajax/ruxitagentjs_$1_1.js",
        )];
        let request = req(
            "GET",
            "https",
            "cdn.example.com",
            "/ruxitagentjs_A2qru_10240521134502.js",
        );
        match evaluate_request_rules(&rules, &request) {
            RequestOutcome::MapRemote { url, rule_id, .. } => {
                assert_eq!(url, "http://localhost:8080/ajax/ruxitagentjs_A2qru_1.js");
                assert_eq!(rule_id, "m");
            }
            other => panic!("expected MapRemote, got {other:?}"),
        }
    }

    #[test]
    fn map_remote_expands_named_groups() {
        let rules = vec![map_remote_rule(
            "m",
            r"https://[^/]+/api/(?P<rest>.*)",
            MatchKind::Regex,
            "http://localhost:8080/${rest}",
        )];
        match evaluate_request_rules(
            &rules,
            &req("GET", "https", "api.test", "/api/users?page=2"),
        ) {
            RequestOutcome::MapRemote { url, .. } => {
                assert_eq!(url, "http://localhost:8080/users?page=2");
            }
            other => panic!("expected MapRemote, got {other:?}"),
        }
    }

    #[test]
    fn map_remote_contains_matcher_uses_target_verbatim() {
        let rules = vec![map_remote_rule(
            "m",
            "/api/",
            MatchKind::Contains,
            "http://localhost:9000/mock",
        )];
        match evaluate_request_rules(&rules, &req("GET", "https", "api.test", "/api/users")) {
            RequestOutcome::MapRemote { url, .. } => {
                assert_eq!(url, "http://localhost:9000/mock");
            }
            other => panic!("expected MapRemote, got {other:?}"),
        }
    }

    #[test]
    fn map_remote_invalid_target_skips_to_next_rule() {
        // A relative (or otherwise unforwardable) target skips the rule instead
        // of breaking the flow — the later mock still fires.
        let rules = vec![
            map_remote_rule("m", "/x", MatchKind::Contains, "/not-absolute"),
            respond_rule("fallback", "/x"),
        ];
        match evaluate_request_rules(&rules, &req("GET", "https", "h", "/x")) {
            RequestOutcome::Respond { rule_id, .. } => assert_eq!(rule_id, "fallback"),
            other => panic!("expected the fallback mock, got {other:?}"),
        }
    }

    #[test]
    fn map_remote_carries_header_edits_from_both_layers() {
        let ar = ar_with(
            vec![req_header_rule("g", "/x", "x-general", "1")],
            Some((
                "A",
                vec![
                    req_header_rule("a", "/x", "x-active", "1"),
                    map_remote_rule("m", "/x", MatchKind::Contains, "http://localhost:1234/x"),
                ],
            )),
            true,
        );
        match ar.evaluate_request(&req("GET", "https", "h", "/x")) {
            RequestOutcome::MapRemote {
                url, set_headers, ..
            } => {
                assert_eq!(url, "http://localhost:1234/x");
                assert_eq!(
                    set_headers,
                    vec![
                        ("x-general".to_string(), "1".to_string()),
                        ("x-active".to_string(), "1".to_string()),
                    ],
                    "General-layer edits ride along, first"
                );
            }
            other => panic!("expected MapRemote, got {other:?}"),
        }
    }

    #[test]
    fn map_remote_respects_fire_limit() {
        let mut rule = map_remote_rule("m", "/x", MatchKind::Contains, "http://localhost:1234/x");
        rule.fire_limit = Some(1);
        let rules = vec![rule];
        let mut cursors = RuleCursors::default();
        let request = req("GET", "https", "h", "/x");
        assert!(matches!(
            evaluate_request_rules_stateful(&rules, &request, &mut cursors),
            RequestOutcome::MapRemote { .. }
        ));
        assert!(
            matches!(
                evaluate_request_rules_stateful(&rules, &request, &mut cursors),
                RequestOutcome::Continue { .. }
            ),
            "a spent map rule passes the request through"
        );
    }

    #[test]
    fn brace_numeric_refs_rewrites_only_unbraced_numbers() {
        assert_eq!(brace_numeric_refs("a_$1_1.js"), "a_${1}_1.js");
        assert_eq!(brace_numeric_refs("$10x"), "${10}x");
        assert_eq!(brace_numeric_refs("$$1"), "$$1", "escaped $ is untouched");
        assert_eq!(
            brace_numeric_refs("${1}b"),
            "${1}b",
            "already braced is untouched"
        );
        assert_eq!(
            brace_numeric_refs("$name"),
            "$name",
            "named refs are untouched"
        );
        assert_eq!(brace_numeric_refs("end$"), "end$");
    }

    #[test]
    fn url_scope_search_matches_map_remote_target() {
        let rule = map_remote_rule(
            "m",
            "/api",
            MatchKind::Contains,
            "http://localhost:8080/mock",
        );
        assert!(rule_matches_scope(
            &rule,
            RuleSearchScope::Url,
            "localhost:8080"
        ));
        assert!(rule_matches_scope(
            &rule,
            RuleSearchScope::All,
            "localhost:8080"
        ));
        assert!(!rule_matches_scope(
            &rule,
            RuleSearchScope::Url,
            "elsewhere"
        ));
    }
}
