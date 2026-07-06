//! User-authored scripts that mutate requests/responses on the wire.
//!
//! A small, sandboxed Rhai engine runs each enabled script's optional
//! `on_request(req)` / `on_response(req, res)` hooks over every intercepted
//! exchange — real upstream responses AND rule-synthesized mocks — letting a user
//! do generically what a fixed rule can't (e.g. stamp CORS headers on every
//! response). Rhai is pure-Rust and sandboxed: no file/network/system access, and
//! a per-run operation cap so a runaway script can't hang the proxy.
//!
//! The engine is GUI-free and lives beside the autoresponder in [`Shared`]. The
//! handler calls [`ScriptEngine::run_request`] / [`ScriptEngine::run_response`]
//! and replays the returned [`Effects`] onto the wire message.
//!
//! [`Shared`]: crate::shared::Shared

use std::sync::{Arc, Mutex};

use rhai::{Dynamic, Engine, ImmutableString, Scope, AST};
use serde::{Deserialize, Serialize};

use crate::flow::{CapturedRequest, CapturedResponse};

/// Per-run operation cap. A single hook invocation that exceeds it is aborted
/// with an error (caught and logged), so an accidental infinite loop degrades to
/// "this script did nothing" rather than stalling every request.
const MAX_OPERATIONS: u64 = 500_000;

/// A single user script. `source` is Rhai and may define `on_request(req)` and/or
/// `on_response(req, res)`. Persisted verbatim in the shell's `scripts.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub source: String,
}

/// Compile feedback for one script, surfaced to the editor. `error` is `None`
/// when the source compiled cleanly.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnostic {
    pub id: String,
    pub name: String,
    pub error: Option<String>,
}

/// A header mutation a script requested, replayed onto the real message by the
/// handler (against a `HeaderMap` for requests, the captured `Vec` for responses).
#[derive(Debug, Clone, PartialEq)]
pub enum HeaderOp {
    Set(String, String),
    Add(String, String),
    Remove(String),
}

/// The net changes one script phase requested. `status` is only meaningful for
/// the response phase (the request phase ignores it).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Effects {
    pub header_ops: Vec<HeaderOp>,
    pub status: Option<u16>,
}

/// The request/response value handed to a script. Reads come from a snapshot;
/// mutations are recorded as [`HeaderOp`]s (and a status override) AND applied to
/// the snapshot, so later reads — and later scripts in the chain — see them. It is
/// `Arc<Mutex<..>>`-backed so the clone Rhai binds into the call scope shares the
/// same state we read back afterwards.
#[derive(Clone)]
struct HttpMessage {
    state: Arc<Mutex<MsgState>>,
}

struct MsgState {
    method: String,
    url: String,
    host: String,
    path: String,
    query: String,
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    ops: Vec<HeaderOp>,
    status_override: Option<u16>,
}

impl HttpMessage {
    fn new(state: MsgState) -> Self {
        Self { state: Arc::new(Mutex::new(state)) }
    }

    fn from_request(req: &CapturedRequest) -> Self {
        let (path, query) = split_path(&req.path);
        Self::new(MsgState {
            method: req.method.clone(),
            url: req.uri.clone(),
            host: req.host.clone(),
            path,
            query,
            status: 0,
            headers: req.headers.clone(),
            body: req.body.clone(),
            ops: Vec::new(),
            status_override: None,
        })
    }

    fn from_response(res: &CapturedResponse) -> Self {
        Self::new(MsgState {
            method: String::new(),
            url: String::new(),
            host: String::new(),
            path: String::new(),
            query: String::new(),
            status: res.status,
            headers: res.headers.clone(),
            body: res.body.clone(),
            ops: Vec::new(),
            status_override: None,
        })
    }

    /// A blank request context, for the response phase when the originating
    /// request could not be recovered (should not happen in practice).
    fn empty() -> Self {
        Self::new(MsgState {
            method: String::new(),
            url: String::new(),
            host: String::new(),
            path: String::new(),
            query: String::new(),
            status: 0,
            headers: Vec::new(),
            body: Vec::new(),
            ops: Vec::new(),
            status_override: None,
        })
    }

    fn effects(&self) -> Effects {
        match self.state.lock() {
            Ok(s) => Effects { header_ops: s.ops.clone(), status: s.status_override },
            Err(_) => Effects::default(),
        }
    }

    fn get_method(&self) -> ImmutableString {
        self.state.lock().map(|s| s.method.clone()).unwrap_or_default().into()
    }
    fn get_url(&self) -> ImmutableString {
        self.state.lock().map(|s| s.url.clone()).unwrap_or_default().into()
    }
    fn get_host(&self) -> ImmutableString {
        self.state.lock().map(|s| s.host.clone()).unwrap_or_default().into()
    }
    fn get_path(&self) -> ImmutableString {
        self.state.lock().map(|s| s.path.clone()).unwrap_or_default().into()
    }
    fn get_query(&self) -> ImmutableString {
        self.state.lock().map(|s| s.query.clone()).unwrap_or_default().into()
    }
    fn get_status(&self) -> i64 {
        self.state.lock().map_or(0, |s| i64::from(s.status))
    }
    fn get_body(&self) -> ImmutableString {
        self.state
            .lock()
            .map(|s| String::from_utf8_lossy(&s.body).into_owned())
            .unwrap_or_default()
            .into()
    }

    fn header(&self, name: &str) -> ImmutableString {
        self.state
            .lock()
            .ok()
            .and_then(|s| {
                s.headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
            })
            .unwrap_or_default()
            .into()
    }

    fn has_header(&self, name: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|s| s.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)))
    }

    fn set_header(&self, name: &str, value: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
            s.headers.push((name.to_string(), value.to_string()));
            s.ops.push(HeaderOp::Set(name.to_string(), value.to_string()));
        }
    }

    fn add_header(&self, name: &str, value: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.headers.push((name.to_string(), value.to_string()));
            s.ops.push(HeaderOp::Add(name.to_string(), value.to_string()));
        }
    }

    fn remove_header(&self, name: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
            s.ops.push(HeaderOp::Remove(name.to_string()));
        }
    }

    fn set_status(&self, code: i64) {
        if let Ok(mut s) = self.state.lock() {
            let code = code.clamp(100, 599) as u16;
            s.status = code;
            s.status_override = Some(code);
        }
    }
}

/// Split a captured `path` (which is stored as path + query) into the two parts,
/// so scripts get a clean `req.path` and `req.query`.
fn split_path(full: &str) -> (String, String) {
    match full.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (full.to_string(), String::new()),
    }
}

/// One user script compiled ready-to-run. `ast` is `None` when the source failed
/// to compile — such a script is simply inert (its error was reported at set time
/// and is re-derivable via [`ScriptEngine::check`]).
struct CompiledScript {
    script: Script,
    ast: Option<AST>,
    has_request: bool,
    has_response: bool,
}

/// The compiled set of user scripts plus the shared, pre-configured Rhai engine.
/// Held behind a `RwLock` in [`Shared`]: read (and executed) per request, replaced
/// wholesale on edit.
///
/// [`Shared`]: crate::shared::Shared
pub struct ScriptEngine {
    engine: Engine,
    scripts: Vec<CompiledScript>,
}

impl ScriptEngine {
    pub fn new() -> Self {
        Self { engine: build_engine(), scripts: Vec::new() }
    }

    /// Replace the whole set, compiling each script. Returns a diagnostic per
    /// script (in order) so the editor can flag the ones that failed to compile.
    pub fn set_scripts(&mut self, scripts: Vec<Script>) -> Vec<ScriptDiagnostic> {
        let mut diagnostics = Vec::with_capacity(scripts.len());
        let mut compiled = Vec::with_capacity(scripts.len());
        for script in scripts {
            let (ast, error, has_request, has_response) = match self.engine.compile(&script.source) {
                Ok(ast) => {
                    let has_request = ast.iter_functions().any(|f| f.name == "on_request");
                    let has_response = ast.iter_functions().any(|f| f.name == "on_response");
                    (Some(ast), None, has_request, has_response)
                }
                Err(err) => (None, Some(err.to_string()), false, false),
            };
            diagnostics.push(ScriptDiagnostic {
                id: script.id.clone(),
                name: script.name.clone(),
                error,
            });
            compiled.push(CompiledScript { script, ast, has_request, has_response });
        }
        self.scripts = compiled;
        diagnostics
    }

    /// The stored scripts (source and all), in order.
    pub fn scripts(&self) -> Vec<Script> {
        self.scripts.iter().map(|c| c.script.clone()).collect()
    }

    /// Compile `source` without storing it, returning the error message if it
    /// doesn't compile — for live validation in the editor.
    pub fn check(&self, source: &str) -> Option<String> {
        self.engine.compile(source).err().map(|e| e.to_string())
    }

    /// Whether any enabled, compiling script defines an `on_request` hook — a cheap
    /// gate so the handler skips all script work (and a body clone) when unused.
    pub fn wants_request(&self) -> bool {
        self.scripts
            .iter()
            .any(|c| c.script.enabled && c.has_request && c.ast.is_some())
    }

    /// Whether any enabled, compiling script defines an `on_response` hook.
    pub fn wants_response(&self) -> bool {
        self.scripts
            .iter()
            .any(|c| c.script.enabled && c.has_response && c.ast.is_some())
    }

    /// Run every enabled `on_request` hook, in order, over `req`. Each script sees
    /// the mutations of the ones before it. A script that errors (syntax-clean but
    /// throws, or blows the op cap) is logged and skipped — the rest still run.
    pub fn run_request(&self, req: &CapturedRequest) -> Effects {
        let req_msg = HttpMessage::from_request(req);
        for compiled in &self.scripts {
            if !compiled.script.enabled || !compiled.has_request {
                continue;
            }
            let Some(ast) = &compiled.ast else { continue };
            let mut scope = Scope::new();
            if let Err(err) =
                self.engine
                    .call_fn::<Dynamic>(&mut scope, ast, "on_request", (req_msg.clone(),))
            {
                tracing::warn!("script '{}' on_request failed: {err}", compiled.script.name);
            }
        }
        req_msg.effects()
    }

    /// Run every enabled `on_response` hook, in order, over `res` (with the
    /// originating `req` for context). Same isolation as [`run_request`].
    ///
    /// [`run_request`]: Self::run_request
    pub fn run_response(&self, req: Option<&CapturedRequest>, res: &CapturedResponse) -> Effects {
        let request = req.map_or_else(HttpMessage::empty, HttpMessage::from_request);
        let response = HttpMessage::from_response(res);
        for compiled in &self.scripts {
            if !compiled.script.enabled || !compiled.has_response {
                continue;
            }
            let Some(ast) = &compiled.ast else { continue };
            let mut scope = Scope::new();
            if let Err(err) = self.engine.call_fn::<Dynamic>(
                &mut scope,
                ast,
                "on_response",
                (request.clone(), response.clone()),
            ) {
                tracing::warn!("script '{}' on_response failed: {err}", compiled.script.name);
            }
        }
        response.effects()
    }
}

impl Default for ScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the sandboxed Rhai engine: operation/recursion caps, muted print/debug,
/// and the `HttpMessage` API (properties + header/status mutators) scripts use.
fn build_engine() -> Engine {
    let mut engine = Engine::new();
    engine.set_max_operations(MAX_OPERATIONS);
    engine.set_max_call_levels(64);
    engine.set_max_expr_depths(128, 64);
    // Scripts run on the hot path; don't let print/debug spam the proxy log.
    engine.on_print(|_| {});
    engine.on_debug(|_, _, _| {});

    engine.register_type_with_name::<HttpMessage>("HttpMessage");
    engine.register_get("method", |m: &mut HttpMessage| m.get_method());
    engine.register_get("url", |m: &mut HttpMessage| m.get_url());
    engine.register_get("host", |m: &mut HttpMessage| m.get_host());
    engine.register_get("path", |m: &mut HttpMessage| m.get_path());
    engine.register_get("query", |m: &mut HttpMessage| m.get_query());
    engine.register_get("status", |m: &mut HttpMessage| m.get_status());
    engine.register_get("body", |m: &mut HttpMessage| m.get_body());
    engine.register_fn("header", |m: &mut HttpMessage, name: ImmutableString| m.header(&name));
    engine.register_fn("has_header", |m: &mut HttpMessage, name: ImmutableString| {
        m.has_header(&name)
    });
    engine.register_fn(
        "set_header",
        |m: &mut HttpMessage, name: ImmutableString, value: ImmutableString| {
            m.set_header(&name, &value);
        },
    );
    engine.register_fn(
        "add_header",
        |m: &mut HttpMessage, name: ImmutableString, value: ImmutableString| {
            m.add_header(&name, &value);
        },
    );
    engine.register_fn("remove_header", |m: &mut HttpMessage, name: ImmutableString| {
        m.remove_header(&name);
    });
    engine.register_fn("set_status", |m: &mut HttpMessage, code: i64| m.set_status(code));
    engine
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_with(source: &str) -> ScriptEngine {
        let mut engine = ScriptEngine::new();
        engine.set_scripts(vec![Script {
            id: "s1".into(),
            name: "test".into(),
            enabled: true,
            source: source.into(),
        }]);
        engine
    }

    fn request() -> CapturedRequest {
        CapturedRequest {
            method: "GET".into(),
            uri: "https://api.example.com/v1/data?page=2".into(),
            scheme: "https".into(),
            host: "api.example.com".into(),
            path: "/v1/data?page=2".into(),
            version: "HTTP/1.1".into(),
            headers: vec![("accept".into(), "application/json".into())],
            body: b"hello".to_vec(),
            timestamp_ms: 0,
        }
    }

    fn response() -> CapturedResponse {
        CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: b"{}".to_vec(),
            timestamp_ms: 0,
        }
    }

    const CORS: &str = r#"
        fn on_response(req, res) {
            res.set_header("Access-Control-Allow-Origin", "*");
            res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            res.set_header("Access-Control-Allow-Headers", "*");
        }
    "#;

    #[test]
    fn the_cors_use_case_stamps_response_headers() {
        let engine = engine_with(CORS);
        assert!(engine.wants_response());
        assert!(!engine.wants_request());
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(effects.status, None);
        assert_eq!(
            effects.header_ops,
            vec![
                HeaderOp::Set("Access-Control-Allow-Origin".into(), "*".into()),
                HeaderOp::Set(
                    "Access-Control-Allow-Methods".into(),
                    "GET, POST, PUT, DELETE, OPTIONS".into()
                ),
                HeaderOp::Set("Access-Control-Allow-Headers".into(), "*".into()),
            ]
        );
    }

    #[test]
    fn set_header_replaces_and_remove_drops() {
        let engine = engine_with(
            r#"
            fn on_response(req, res) {
                res.set_header("content-type", "text/plain");
                res.remove_header("x-powered-by");
            }
        "#,
        );
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(
            effects.header_ops,
            vec![
                HeaderOp::Set("content-type".into(), "text/plain".into()),
                HeaderOp::Remove("x-powered-by".into()),
            ]
        );
    }

    #[test]
    fn add_header_appends_without_replacing() {
        let engine = engine_with(
            r#"
            fn on_response(req, res) {
                res.add_header("set-cookie", "a=1");
                res.add_header("set-cookie", "b=2");
            }
        "#,
        );
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(
            effects.header_ops,
            vec![
                HeaderOp::Add("set-cookie".into(), "a=1".into()),
                HeaderOp::Add("set-cookie".into(), "b=2".into()),
            ]
        );
    }

    #[test]
    fn set_status_is_reported_and_clamped() {
        let engine = engine_with("fn on_response(req, res) { res.set_status(503); }");
        assert_eq!(engine.run_response(Some(&request()), &response()).status, Some(503));
        let clamped = engine_with("fn on_response(req, res) { res.set_status(9000); }");
        assert_eq!(clamped.run_response(Some(&request()), &response()).status, Some(599));
    }

    #[test]
    fn on_request_injects_a_header() {
        let engine = engine_with(r#"fn on_request(req) { req.set_header("x-germi", "1"); }"#);
        assert!(engine.wants_request());
        let effects = engine.run_request(&request());
        assert_eq!(effects.header_ops, vec![HeaderOp::Set("x-germi".into(), "1".into())]);
    }

    #[test]
    fn scripts_can_read_request_fields_and_branch() {
        let engine = engine_with(
            r#"
            fn on_response(req, res) {
                if req.host == "api.example.com" && req.path == "/v1/data" {
                    res.set_header("x-matched", req.query);
                }
            }
        "#,
        );
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(effects.header_ops, vec![HeaderOp::Set("x-matched".into(), "page=2".into())]);
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let engine = engine_with(
            r#"
            fn on_response(req, res) {
                if res.has_header("Content-Type") {
                    res.set_header("x-ct", res.header("CONTENT-TYPE"));
                }
            }
        "#,
        );
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(
            effects.header_ops,
            vec![HeaderOp::Set("x-ct".into(), "application/json".into())]
        );
    }

    #[test]
    fn a_later_script_sees_an_earlier_scripts_change() {
        let mut engine = ScriptEngine::new();
        engine.set_scripts(vec![
            Script {
                id: "a".into(),
                name: "a".into(),
                enabled: true,
                source: r#"fn on_response(req, res) { res.set_header("x-a", "1"); }"#.into(),
            },
            Script {
                id: "b".into(),
                name: "b".into(),
                enabled: true,
                source: r#"fn on_response(req, res) { if res.header("x-a") == "1" { res.set_header("x-b", "2"); } }"#.into(),
            },
        ]);
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(
            effects.header_ops,
            vec![
                HeaderOp::Set("x-a".into(), "1".into()),
                HeaderOp::Set("x-b".into(), "2".into()),
            ]
        );
    }

    #[test]
    fn disabled_scripts_are_skipped() {
        let mut engine = ScriptEngine::new();
        engine.set_scripts(vec![Script {
            id: "s".into(),
            name: "off".into(),
            enabled: false,
            source: CORS.into(),
        }]);
        assert!(!engine.wants_response());
        assert_eq!(engine.run_response(Some(&request()), &response()), Effects::default());
    }

    #[test]
    fn a_script_without_the_hook_is_a_noop() {
        let engine = engine_with("fn helper() { 1 + 1 }");
        assert!(!engine.wants_request());
        assert!(!engine.wants_response());
        assert_eq!(engine.run_response(Some(&request()), &response()), Effects::default());
    }

    #[test]
    fn a_compile_error_is_reported_and_the_script_stays_inert() {
        let mut engine = ScriptEngine::new();
        let diagnostics = engine.set_scripts(vec![Script {
            id: "bad".into(),
            name: "broken".into(),
            enabled: true,
            source: "fn on_response(req, res) { this is not valid".into(),
        }]);
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].error.is_some(), "the syntax error is surfaced");
        assert!(!engine.wants_response(), "an uncompilable script never runs");
        assert_eq!(engine.run_response(Some(&request()), &response()), Effects::default());
    }

    #[test]
    fn a_runtime_error_in_one_script_does_not_block_the_others() {
        let mut engine = ScriptEngine::new();
        engine.set_scripts(vec![
            Script {
                id: "boom".into(),
                name: "boom".into(),
                enabled: true,
                // Calls an undefined function -> runtime error.
                source: r"fn on_response(req, res) { nope(); }".into(),
            },
            Script {
                id: "ok".into(),
                name: "ok".into(),
                enabled: true,
                source: r#"fn on_response(req, res) { res.set_header("x-ok", "1"); }"#.into(),
            },
        ]);
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(effects.header_ops, vec![HeaderOp::Set("x-ok".into(), "1".into())]);
    }

    #[test]
    fn an_infinite_loop_is_bounded_not_hung() {
        // If the operation cap were not enforced this test would never return.
        let engine = engine_with("fn on_response(req, res) { let i = 0; while true { i += 1; } }");
        let effects = engine.run_response(Some(&request()), &response());
        assert_eq!(effects, Effects::default(), "the aborted script leaves no changes");
    }

    #[test]
    fn check_reports_syntax_errors_and_accepts_valid_source() {
        let engine = ScriptEngine::new();
        assert!(engine.check("fn on_response(req, res) {").is_some());
        assert!(engine.check(CORS).is_none());
    }

    #[test]
    fn scripts_round_trip_through_the_engine() {
        let mut engine = ScriptEngine::new();
        let input = vec![Script {
            id: "s1".into(),
            name: "cors".into(),
            enabled: true,
            source: CORS.into(),
        }];
        engine.set_scripts(input.clone());
        assert_eq!(engine.scripts(), input);
    }

    #[test]
    fn run_response_tolerates_a_missing_request_context() {
        let engine = engine_with(CORS);
        // req is None: the response phase still runs (req fields read as empty).
        let effects = engine.run_response(None, &response());
        assert_eq!(effects.header_ops.len(), 3);
    }

    #[test]
    fn script_dto_round_trips_camel_case_and_loads_a_legacy_blank() {
        let script = Script {
            id: "s1".into(),
            name: "cors".into(),
            enabled: true,
            source: "fn on_response(req, res) {}".into(),
        };
        let json = serde_json::to_string(&script).expect("serialize");
        assert_eq!(serde_json::from_str::<Script>(&json).expect("round trip"), script);
        // Every field is #[serde(default)], so an older/blank object still loads.
        let blank: Script = serde_json::from_str("{}").expect("legacy load");
        assert_eq!(blank, Script::default_for_test());
    }

    impl Script {
        fn default_for_test() -> Self {
            Self { id: String::new(), name: String::new(), enabled: false, source: String::new() }
        }
    }
}
