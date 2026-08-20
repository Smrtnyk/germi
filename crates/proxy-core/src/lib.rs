//! `proxy-core` — the standalone MITM proxy engine behind Germi.
//!
//! It has **no** GUI/webkit dependency, so it builds, tests and runs on its own
//! (`cargo run -p proxy-core --example standalone`). The Tauri shell is a thin
//! wrapper that drives the [`ProxyController`] and forwards [`FlowEvent`]s to the
//! webview.
//!
//! ```no_run
//! # async fn demo() -> anyhow::Result<()> {
//! use proxy_core::ProxyController;
//! use std::net::SocketAddr;
//!
//! let ca = ProxyController::load_or_generate_ca(std::path::Path::new("/tmp/germi"))?;
//! let controller = ProxyController::new(ca);
//! let mut events = controller.subscribe();
//! controller.start("127.0.0.1:8080".parse::<SocketAddr>()?).await?;
//! while let Ok(event) = events.recv().await {
//!     println!("{event:?}");
//! }
//! # Ok(())
//! # }
//! ```

mod body;
mod ca;
mod farx;
mod flow;
mod handler;
mod har_export;
mod history;
mod http_semantics;
mod import;
mod reissue;
mod rules;
mod rules_export;
mod scripting;
mod settings;
mod settings_io;
mod shared;
mod store;
mod tester;

use std::borrow::Cow;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::Proxy;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

pub use ca::CertAuthority;
pub use flow::{
    Availability, AvailabilityVerdict, BodyComparison, FlowDetail, FlowEvent, FlowSummary,
    MessageDetail, ResourceKind,
};
pub use history::HistoryTag;
pub use import::har_embedded_rules;
pub use import::{CaptureImportProgress, CaptureImportStage, CAPTURE_IMPORT_CANCELLED};
pub use rules::{
    Action, ActionSummary, AutoResponder, AutoResponderSummary, MatchKind, Matcher, Rule,
    RuleSearchScope, RuleSet, RuleSummary, Scenario, ScenarioSummary, GENERAL_SCENARIO_ID,
    GENERAL_SCENARIO_NAME,
};
pub use rules_export::{
    preview_rules, preview_rules_file, GeneralRulesImportMode, RulesExport, ScenarioPreview,
};
pub use scripting::{Script, ScriptDiagnostic};
pub use settings::{FilterColorPresets, ProxySettings};
pub use settings_io::{
    export_sections, import_preview, merge_import, section_summaries, SectionSummary,
};
pub use tester::{test_rules, SequenceStep, TestInput, TestResponse, TestResult};

use handler::CaptureHandler;
use history::{HistoryEntry, HistoryOp};
use shared::Shared;

/// Maximum number of flows retained in memory before oldest are evicted.
const MAX_FLOWS: usize = 5_000;
/// Max concurrent outbound availability checks (bounds load + open sockets).
const AVAILABILITY_CONCURRENCY: usize = 12;
/// Long-lived tunnels and stalled upstreams must not make Stop/Restart wait
/// forever. Hudsucker begins graceful connection shutdown immediately; after
/// this window, abort its serving coordinator so the listener/controller can
/// make progress even if a connection never drains.
const PROXY_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
static ENTITY_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_entity_id(prefix: &str) -> String {
    let timestamp = crate::flow::now_ms();
    let counter = ENTITY_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{timestamp}-{counter}")
}

/// Lightweight result of bulk-mocking flows into a scenario.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MockResult {
    pub scenario_id: String,
    pub new_rule_ids: Vec<String>,
}

/// Outcome of an undo/redo/jump: whether the autoresponder changed (so the
/// Tauri layer re-persists it).
pub struct HistoryStep {
    pub mock_changed: bool,
}

/// A prepared bulk mutation. Building can be slow for hundreds of large
/// responses; committing it is an atomic in-memory append.
#[derive(Clone, Debug)]
pub struct MockBatch {
    pub scenario_id: String,
    pub scenario_name: String,
    pub create_scenario: bool,
    pub rules: Vec<Rule>,
}

/// Which side(s) of a flow a content search scans.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchSide {
    Request,
    Response,
    Either,
}

/// One logical source searched by a traffic-filter term. `All` is URL OR raw
/// headers OR decoded textual bodies; `Content` is the same without URL.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowFilterField {
    All,
    Content,
    Body,
    Headers,
    Cookies,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowFilterTerm {
    pub field: FlowFilterField,
    pub side: SearchSide,
    pub value: String,
    pub regex: bool,
    pub neg: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowFilterRequest {
    pub key: String,
    pub candidates: Vec<String>,
    pub terms: Vec<FlowFilterTerm>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowFilterMatches {
    pub key: String,
    pub matched: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowFilterBatchResult {
    pub cancelled: bool,
    pub filters: Vec<FlowFilterMatches>,
}

fn cookie_pair(raw: &str) -> Option<String> {
    let (name, value) = raw.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(format!("{name}={}", value.trim()))
}

fn cookie_pairs(headers: &[(String, String)], side: SearchSide) -> Vec<String> {
    let mut pairs = Vec::new();
    for (name, value) in headers {
        match side {
            SearchSide::Request if name.eq_ignore_ascii_case("cookie") => {
                pairs.extend(value.split(';').filter_map(cookie_pair));
            }
            SearchSide::Response if name.eq_ignore_ascii_case("set-cookie") => {
                if let Some(pair) = value.split(';').next().and_then(cookie_pair) {
                    pairs.push(pair);
                }
            }
            _ => {}
        }
    }
    pairs
}

enum FlowFilterPattern {
    Compiled(regex::Regex),
    InvalidRegex,
}

impl FlowFilterPattern {
    fn new(value: &str, regex: bool) -> Self {
        let expression = if regex {
            value.to_string()
        } else {
            regex::escape(value)
        };
        regex::RegexBuilder::new(&expression)
            .case_insensitive(true)
            .build()
            .map_or(Self::InvalidRegex, Self::Compiled)
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Compiled(regex) => regex.is_match(text),
            Self::InvalidRegex => false,
        }
    }
}

struct CompiledFlowFilterTerm {
    field: FlowFilterField,
    side: SearchSide,
    pattern: FlowFilterPattern,
    neg: bool,
}

struct MessageSearchDocument<'a> {
    body_bytes: &'a [u8],
    headers_source: &'a [(String, String)],
    side: SearchSide,
    headers: OnceLock<String>,
    body: OnceLock<Option<Cow<'a, str>>>,
    cookies: OnceLock<Vec<String>>,
}

#[cfg(test)]
thread_local! {
    static FILTER_BODY_PROJECTIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FILTER_BODY_OWNED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FILTER_BODY_PEAK_OWNED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn record_filter_body_projection(owned_bytes: usize) {
    FILTER_BODY_PROJECTIONS.set(FILTER_BODY_PROJECTIONS.get() + 1);
    if owned_bytes > 0 {
        let live = FILTER_BODY_OWNED_BYTES.get() + owned_bytes;
        FILTER_BODY_OWNED_BYTES.set(live);
        FILTER_BODY_PEAK_OWNED_BYTES.set(FILTER_BODY_PEAK_OWNED_BYTES.get().max(live));
    }
}

#[cfg(test)]
fn reset_filter_body_projection_stats() {
    assert_eq!(FILTER_BODY_OWNED_BYTES.get(), 0);
    FILTER_BODY_PROJECTIONS.set(0);
    FILTER_BODY_PEAK_OWNED_BYTES.set(0);
}

#[cfg(test)]
fn filter_body_projection_stats() -> (usize, usize, usize) {
    (
        FILTER_BODY_PROJECTIONS.get(),
        FILTER_BODY_OWNED_BYTES.get(),
        FILTER_BODY_PEAK_OWNED_BYTES.get(),
    )
}

impl<'a> MessageSearchDocument<'a> {
    fn new(side: SearchSide, body: &'a [u8], headers: &'a [(String, String)]) -> Self {
        Self {
            body_bytes: body,
            headers_source: headers,
            side,
            headers: OnceLock::new(),
            body: OnceLock::new(),
            cookies: OnceLock::new(),
        }
    }

    fn headers(&self) -> &str {
        self.headers.get_or_init(|| {
            self.headers_source
                .iter()
                .map(|(key, value)| format!("{key}: {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        })
    }

    fn body(&self) -> Option<&str> {
        self.body
            .get_or_init(|| {
                if !crate::flow::is_textual(self.headers_source) {
                    return None;
                }
                let body = match crate::body::decode_body(self.headers_source, self.body_bytes) {
                    Some((decoded, _truncated)) => Some(match String::from_utf8(decoded) {
                        Ok(text) => Cow::Owned(text),
                        Err(error) => {
                            Cow::Owned(String::from_utf8_lossy(error.as_bytes()).into_owned())
                        }
                    }),
                    None => Some(String::from_utf8_lossy(self.body_bytes)),
                };
                #[cfg(test)]
                record_filter_body_projection(match &body {
                    Some(Cow::Owned(text)) => text.len(),
                    _ => 0,
                });
                body
            })
            .as_deref()
    }

    fn cookies(&self) -> &[String] {
        self.cookies
            .get_or_init(|| cookie_pairs(self.headers_source, self.side))
    }

    fn matches(&self, field: FlowFilterField, pattern: &FlowFilterPattern) -> bool {
        match field {
            FlowFilterField::All | FlowFilterField::Content => {
                pattern.matches(self.headers())
                    || self.body().is_some_and(|body| pattern.matches(body))
            }
            FlowFilterField::Body => self.body().is_some_and(|body| pattern.matches(body)),
            FlowFilterField::Headers => pattern.matches(self.headers()),
            FlowFilterField::Cookies => self.cookies().iter().any(|pair| pattern.matches(pair)),
        }
    }
}

#[cfg(test)]
impl Drop for MessageSearchDocument<'_> {
    fn drop(&mut self) {
        if let Some(Some(Cow::Owned(text))) = self.body.get() {
            FILTER_BODY_OWNED_BYTES.set(FILTER_BODY_OWNED_BYTES.get() - text.len());
        }
    }
}

struct FlowFilterEvaluation<'a> {
    filter_index: usize,
    terms: &'a [CompiledFlowFilterTerm],
    hits: Vec<bool>,
    viable: bool,
}

impl FlowFilterEvaluation<'_> {
    fn needs_side(&self, side: SearchSide) -> bool {
        self.viable
            && self
                .terms
                .iter()
                .zip(&self.hits)
                .any(|(term, hit)| !hit && term_scans_side(term.side, side))
    }

    fn scan_message(&mut self, side: SearchSide, document: &MessageSearchDocument<'_>) {
        if !self.viable {
            return;
        }
        for (term, hit) in self.terms.iter().zip(&mut self.hits) {
            if !*hit && term_scans_side(term.side, side) {
                *hit = document.matches(term.field, &term.pattern);
            }
        }
        if self
            .terms
            .iter()
            .zip(&self.hits)
            .any(|(term, hit)| term.neg && *hit)
        {
            self.viable = false;
            return;
        }
        if side == SearchSide::Request
            && self
                .terms
                .iter()
                .zip(&self.hits)
                .any(|(term, hit)| !term.neg && !*hit && term.side == SearchSide::Request)
        {
            self.viable = false;
        }
    }

    fn matched(&self) -> bool {
        self.viable
            && self
                .terms
                .iter()
                .zip(&self.hits)
                .all(|(term, hit)| if term.neg { !*hit } else { *hit })
    }
}

fn term_scans_side(configured: SearchSide, message: SearchSide) -> bool {
    configured == SearchSide::Either || configured == message
}

fn evaluate_flow_filters(
    flow: &crate::flow::Flow,
    id: &str,
    compiled: &[(HashSet<&str>, Vec<CompiledFlowFilterTerm>)],
) -> Vec<usize> {
    let mut evaluations = compiled
        .iter()
        .enumerate()
        .filter(|(_, (candidates, _))| candidates.contains(id))
        .map(|(filter_index, (_, terms))| FlowFilterEvaluation {
            filter_index,
            terms,
            hits: vec![false; terms.len()],
            viable: true,
        })
        .collect::<Vec<_>>();
    if evaluations.is_empty() {
        return Vec::new();
    }

    if evaluations.iter().any(|evaluation| {
        evaluation
            .terms
            .iter()
            .any(|term| term.field == FlowFilterField::All)
    }) {
        let url = format!(
            "{} {}://{}{}",
            flow.request.method, flow.request.scheme, flow.request.host, flow.request.path
        );
        for evaluation in &mut evaluations {
            for (term, hit) in evaluation.terms.iter().zip(&mut evaluation.hits) {
                if term.field == FlowFilterField::All {
                    *hit = term.pattern.matches(&url);
                }
            }
            if evaluation
                .terms
                .iter()
                .zip(&evaluation.hits)
                .any(|(term, hit)| term.neg && *hit)
            {
                evaluation.viable = false;
            }
        }
    }

    if evaluations
        .iter()
        .any(|evaluation| evaluation.needs_side(SearchSide::Request))
    {
        {
            let request = MessageSearchDocument::new(
                SearchSide::Request,
                &flow.request.body,
                &flow.request.headers,
            );
            for evaluation in &mut evaluations {
                if evaluation.needs_side(SearchSide::Request) {
                    evaluation.scan_message(SearchSide::Request, &request);
                }
            }
        }
    }

    if let Some(response) = &flow.response {
        if evaluations
            .iter()
            .any(|evaluation| evaluation.needs_side(SearchSide::Response))
        {
            let response =
                MessageSearchDocument::new(SearchSide::Response, &response.body, &response.headers);
            for evaluation in &mut evaluations {
                if evaluation.needs_side(SearchSide::Response) {
                    evaluation.scan_message(SearchSide::Response, &response);
                }
            }
        }
    }

    evaluations
        .into_iter()
        .filter_map(|evaluation| evaluation.matched().then_some(evaluation.filter_index))
        .collect()
}

/// A live proxy: its bound address, a shutdown signal, and the serving task's
/// join handle (so `stop()` can wait for the listener socket to be released).
type RunningProxy = (SocketAddr, oneshot::Sender<()>, JoinHandle<()>);

#[derive(Clone)]
pub struct CaptureImportHandle {
    id: u64,
    cancelled: Arc<AtomicBool>,
}

impl CaptureImportHandle {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

pub struct CaptureImportResult {
    pub summaries: Vec<FlowSummary>,
    pub embedded_rules: Option<Vec<u8>>,
}

#[derive(Default)]
struct CaptureImportOperations {
    last_id: u64,
    pending: Option<CaptureImportHandle>,
    active: Option<CaptureImportHandle>,
}

/// A serving task can exit independently after a successful bind (for example,
/// a fatal accept-loop error). Do not leave that finished task masquerading as
/// a live listener forever or blocking a later Start/CA regeneration.
fn discard_finished_proxy(slot: &mut Option<RunningProxy>) {
    if slot.as_ref().is_some_and(|(_, _, task)| task.is_finished()) {
        slot.take();
    }
}

async fn shutdown_proxy(
    shutdown: oneshot::Sender<()>,
    mut task: JoinHandle<()>,
    grace: Duration,
) -> bool {
    let _ = shutdown.send(());
    if tokio::time::timeout(grace, &mut task).await.is_ok() {
        return false;
    }
    tracing::warn!(
        grace_ms = grace.as_millis(),
        "proxy connections did not drain before the shutdown deadline; aborting the serving task"
    );
    task.abort();
    let _ = task.await;
    true
}

/// Owns the proxy lifecycle, the captured-flow store and the rules.
pub struct ProxyController {
    shared: Arc<Shared>,
    /// Behind a lock so the CA can be regenerated at runtime.
    ca: RwLock<CertAuthority>,
    /// `Some(..)` while the proxy is running; the bound address lets the UI
    /// re-read the live listen port/scope after a webview reload.
    running: Mutex<Option<RunningProxy>>,
    /// At most one capture import may remain eligible to commit. Claiming a
    /// newer intent marks the older parser cancelled; the full parse happens
    /// outside this lock and the final atomic commit re-validates the handle.
    capture_imports: std::sync::Mutex<CaptureImportOperations>,
}

impl ProxyController {
    /// Build a controller around an already-loaded CA. Seeds an example scenario.
    pub fn new(ca: CertAuthority) -> Self {
        Self {
            shared: Shared::new(
                MAX_FLOWS,
                AutoResponder::example(),
                ProxySettings::default(),
            ),
            ca: RwLock::new(ca),
            running: Mutex::new(None),
            capture_imports: std::sync::Mutex::new(CaptureImportOperations::default()),
        }
    }

    /// Load (or first-run generate + persist) the root CA under `dir`.
    pub fn load_or_generate_ca(dir: &Path) -> Result<CertAuthority> {
        CertAuthority::load_or_generate(dir)
    }

    /// Subscribe to the live [`FlowEvent`] stream. Multiple subscribers allowed.
    pub fn subscribe(&self) -> broadcast::Receiver<FlowEvent> {
        self.shared.events.subscribe()
    }

    pub fn ca_cert_pem(&self) -> String {
        self.ca
            .read()
            .map(|c| c.cert_pem.clone())
            .unwrap_or_default()
    }

    pub fn ca_cert_der(&self) -> Vec<u8> {
        self.ca
            .read()
            .map(|c| c.cert_der.clone())
            .unwrap_or_default()
    }

    /// Generate a fresh root CA, persist it under `dir`, and swap it in. The
    /// proxy must be stopped (the running proxy holds the old authority); the
    /// user must re-trust the new CA afterwards.
    pub async fn regenerate_ca(&self, dir: &Path) -> Result<()> {
        // Hold the `running` lock across the whole swap so a concurrent start()
        // cannot read the old CA and bake it into a freshly-spawned proxy in the
        // window between the check and the swap (check-then-act TOCTOU).
        let mut running = self.running.lock().await;
        discard_finished_proxy(&mut running);
        if running.is_some() {
            bail!("stop the proxy before regenerating the CA");
        }
        let new_ca = CertAuthority::generate()?;
        new_ca.save(dir)?;
        let mut guard = self.ca.write().map_err(|_| anyhow!("CA lock poisoned"))?;
        *guard = new_ca;
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        let mut running = self.running.lock().await;
        discard_finished_proxy(&mut running);
        running.is_some()
    }

    /// The address the proxy is currently bound to, or `None` if stopped. Lets the
    /// UI re-read the live listen address (port + LAN scope) after a reload,
    /// instead of guessing from the persisted setting.
    pub async fn bound_addr(&self) -> Option<SocketAddr> {
        let mut running = self.running.lock().await;
        discard_finished_proxy(&mut running);
        running.as_ref().map(|(addr, _, _)| *addr)
    }

    /// Start the proxy listening on `addr`. Errors if already running, or if the
    /// bind fails (e.g. the port is in use). Returns the actually-bound address
    /// (e.g. resolving port 0 to the OS-assigned port).
    pub async fn start(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let mut guard = self.running.lock().await;
        discard_finished_proxy(&mut guard);
        if guard.is_some() {
            bail!("proxy is already running");
        }
        let state = self.spawn_proxy(addr).await?;
        let local_addr = state.0;
        *guard = Some(state);
        Ok(local_addr)
    }

    /// Rebind the running proxy to `addr` (the user changed the port in
    /// settings). The new listener is bound *first*, so a failed bind (usually a
    /// taken port) leaves the existing proxy running untouched and returns the
    /// error — a mistyped port never kills a working proxy. Returns the bound addr.
    pub async fn restart(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let mut guard = self.running.lock().await;

        discard_finished_proxy(&mut guard);
        if guard.as_ref().is_some_and(|(bound, _, _)| *bound == addr) {
            return Ok(addr);
        }

        // `127.0.0.1:PORT` and `0.0.0.0:PORT` overlap. That is exactly the
        // rebind produced by toggling "allow remote devices", so the usual
        // bind-first strategy cannot work. Stop first in this one case, but
        // remember the old address and restore it if the replacement bind
        // fails so a bad setting still does not strand a working proxy.
        if guard
            .as_ref()
            .is_some_and(|(bound, _, _)| bound.port() == addr.port())
        {
            let (old_addr, tx, task) = guard.take().expect("checked running proxy");
            shutdown_proxy(tx, task, PROXY_SHUTDOWN_GRACE).await;
            match self.spawn_proxy(addr).await {
                Ok(state) => {
                    let local_addr = state.0;
                    *guard = Some(state);
                    return Ok(local_addr);
                }
                Err(error) => {
                    let restored = self.spawn_proxy(old_addr).await.map_err(|restore_error| {
                        anyhow!(
                            "failed to bind {addr}: {error}; also failed to restore {old_addr}: {restore_error}"
                        )
                    })?;
                    *guard = Some(restored);
                    return Err(error);
                }
            }
        }

        let state = self.spawn_proxy(addr).await?;
        let local_addr = state.0;
        if let Some((_addr, tx, task)) = guard.take() {
            shutdown_proxy(tx, task, PROXY_SHUTDOWN_GRACE).await;
        }
        *guard = Some(state);
        Ok(local_addr)
    }

    /// Bind `addr`, build the MITM proxy and spawn its serving task, returning the
    /// shutdown handle plus the bound address. The caller owns the `running` slot;
    /// binding here (not in the spawned task) means a bind failure surfaces before
    /// anything is recorded as running, so `start`/`restart` can bind first and
    /// commit only on success.
    async fn spawn_proxy(&self, addr: SocketAddr) -> Result<RunningProxy> {
        // Install a default crypto provider once (ignored if already set).
        let _ = aws_lc_rs::default_provider().install_default();

        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| anyhow!("failed to bind {addr}: {e}"))?;
        let local_addr = listener.local_addr().unwrap_or(addr);

        let authority = {
            let ca = self.ca.read().map_err(|_| anyhow!("CA lock poisoned"))?;
            ca.to_authority()?
        };
        let handler = CaptureHandler::new(self.shared.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let proxy = Proxy::builder()
            .with_listener(listener)
            .with_ca(authority)
            .with_rustls_connector(aws_lc_rs::default_provider())
            .with_http_handler(handler.clone())
            .with_websocket_handler(handler)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .build()
            .map_err(|e| anyhow!("failed to build proxy: {e:?}"))?;

        let task = tokio::spawn(async move {
            if let Err(e) = proxy.start().await {
                tracing::error!("proxy exited with error: {e}");
            }
        });

        Ok((local_addr, shutdown_tx, task))
    }

    /// Gracefully stop the proxy if running. Waits for the proxy task to finish
    /// (the listener socket is released) before returning, so an immediate
    /// restart on the same port doesn't fail with "address already in use".
    pub async fn stop(&self) {
        // Keep lifecycle operations serialized until the old listener is
        // actually gone. Publishing an empty slot before the bounded drain let
        // a concurrent status/start/CA operation observe "stopped" while the
        // socket was still serving (and a same-port Start would then fail).
        let mut running = self.running.lock().await;
        let taken = running.take();
        if let Some((_addr, tx, task)) = taken {
            shutdown_proxy(tx, task, PROXY_SHUTDOWN_GRACE).await;
        }
        drop(running);
    }

    // ---- captured-flow access (for IPC commands) ----

    pub fn list_flows(&self) -> Vec<FlowSummary> {
        let cols = self.shared.header_cols();
        self.shared
            .store
            .lock()
            .map(|s| s.summaries(&cols))
            .unwrap_or_default()
    }

    /// Set or clear a flow's user comment (emits the updated row to subscribers).
    pub fn set_flow_comment(&self, id: &str, comment: Option<String>) {
        self.shared.set_comment(id, comment);
    }

    /// Re-issue the given flows WITHOUT credentials to test whether they are
    /// publicly reachable, caching each verdict on its flow and emitting the
    /// updated row. Only safe methods (GET/HEAD) are re-issued — re-sending a POST
    /// could mutate server state — so other methods (and unknown ids) are skipped.
    /// `on_progress(completed, total)` fires as each check resolves. Returns the
    /// number of flows actually checked.
    pub async fn check_availability(
        &self,
        ids: &[String],
        mut on_progress: impl FnMut(usize, usize),
    ) -> usize {
        // Snapshot targets up front so the network phase never holds the store lock.
        let targets: Vec<(String, reissue::ReissueTarget)> = {
            let Ok(store) = self.shared.store.lock() else {
                return 0;
            };
            ids.iter()
                .filter_map(|id| {
                    let flow = store.get(id)?;
                    let method = flow.request.method.to_ascii_uppercase();
                    if method != "GET" && method != "HEAD" {
                        return None;
                    }
                    let req = &flow.request;
                    let url = req
                        .uri
                        .parse::<hudsucker::hyper::Uri>()
                        .ok()
                        .filter(|uri| uri.scheme().is_some() && uri.authority().is_some())
                        .map_or_else(
                            || format!("{}://{}{}", req.scheme, req.host, req.path),
                            |uri| uri.to_string(),
                        );
                    Some((
                        id.clone(),
                        reissue::ReissueTarget {
                            method,
                            // Captures normally retain an absolute URI; rebuild
                            // from parts as a defensive fallback for older/imported
                            // in-memory data that may carry origin form.
                            url,
                            headers: req.headers.clone(),
                        },
                    ))
                })
                .collect()
        };

        let total = targets.len();
        if total == 0 {
            on_progress(0, 0);
            return 0;
        }

        let client = reissue::build_client();
        let semaphore = Arc::new(Semaphore::new(AVAILABILITY_CONCURRENCY));
        let mut set = JoinSet::new();
        for (id, target) in targets {
            let client = client.clone();
            let semaphore = semaphore.clone();
            set.spawn(async move {
                let _permit = semaphore.acquire_owned().await.ok();
                let availability =
                    reissue::check_public(&client, &target, reissue::CHECK_TIMEOUT).await;
                (id, availability)
            });
        }

        let mut completed = 0;
        while let Some(joined) = set.join_next().await {
            if let Ok((id, availability)) = joined {
                self.shared.set_availability(&id, availability);
            }
            completed += 1;
            on_progress(completed, total);
        }
        completed
    }

    pub fn get_flow(&self, id: &str, decode: bool, full: bool) -> Option<FlowDetail> {
        self.shared
            .store
            .lock()
            .ok()
            .and_then(|s| s.detail(id, decode, full))
    }

    pub fn clear_flows(&self) {
        // Emitted under the store lock, like every event in `shared.rs`, so a
        // concurrent capture can't slot its New between the clear and `Cleared`.
        if let Ok(mut store) = self.shared.store.lock() {
            store.clear();
            let _ = self.shared.events.send(FlowEvent::Cleared);
        }
    }

    /// Remove specific captured flows by id, so the user can prune noise before
    /// saving a HAR archive. Emits `Removed` with the ids (the UI drops
    /// those rows); a no-op that emits nothing when none of the ids were present.
    pub fn remove_flows(&self, ids: &[String]) {
        if let Ok(mut store) = self.shared.store.lock() {
            if store.remove(ids) > 0 {
                let _ = self
                    .shared
                    .events
                    .send(FlowEvent::Removed { ids: ids.to_vec() });
            }
        }
    }

    /// Scan stored bodies (decompressed text) for `pattern`; returns matching
    /// flow ids, optionally restricted to `candidates`. Case-insensitive; skips
    /// binary bodies. The candidate prefilter keeps this cheap in practice.
    pub fn search_bodies(
        &self,
        pattern: &str,
        side: SearchSide,
        regex: bool,
        candidates: Option<&[String]>,
    ) -> Vec<String> {
        self.search_messages(pattern, side, regex, candidates, |_side, body, headers| {
            if !crate::flow::is_textual(headers) {
                return None; // skip binary blobs (images/fonts/media)
            }
            let bytes = match crate::body::decode_body(headers, body) {
                Some((decoded, _truncated)) => decoded,
                None => body.to_vec(),
            };
            Some(vec![String::from_utf8_lossy(&bytes).into_owned()])
        })
    }

    /// Scan stored header tables (rendered `name: value`, one per line) for
    /// `pattern`; returns matching flow ids, optionally restricted to
    /// `candidates`. Case-insensitive; headers are always text (no binary gate).
    pub fn search_headers(
        &self,
        pattern: &str,
        side: SearchSide,
        regex: bool,
        candidates: Option<&[String]>,
    ) -> Vec<String> {
        self.search_messages(pattern, side, regex, candidates, |_side, _body, headers| {
            Some(vec![headers
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join("\n")])
        })
    }

    /// Scan parsed cookie `name=value` pairs. Request searches inspect every
    /// Cookie header; response searches inspect only the leading pair of every
    /// Set-Cookie header, never its attributes. Matching follows body/header
    /// search semantics: case-insensitive plain substring or regex.
    pub fn search_cookies(
        &self,
        pattern: &str,
        side: SearchSide,
        regex: bool,
        candidates: Option<&[String]>,
    ) -> Vec<String> {
        self.search_messages(
            pattern,
            side,
            regex,
            candidates,
            |message_side, _body, headers| {
                let pairs = cookie_pairs(headers, message_side);
                (!pairs.is_empty()).then_some(pairs)
            },
        )
    }

    /// Match a bounded batch of complete filter plans against per-flow store
    /// snapshots. Each plan already carries the ids that passed its frontend
    /// chips/structured constraints. Logical terms AND together; `All` and
    /// `Content` perform their internal OR before negation. Message projections
    /// are lazy and shared across plans, so a body is decompressed at most once
    /// per side and flow for the whole batch. Only the union of requested
    /// candidates is cloned under one store lock, providing a coherent snapshot
    /// without copying the whole capture or duplicating ref-counted body bytes.
    pub fn search_flow_filters(
        &self,
        filters: &[FlowFilterRequest],
        is_cancelled: impl Fn() -> bool,
    ) -> Result<FlowFilterBatchResult> {
        self.search_flow_filters_with_snapshot_hook(filters, is_cancelled, || {})
    }

    fn search_flow_filters_with_snapshot_hook(
        &self,
        filters: &[FlowFilterRequest],
        is_cancelled: impl Fn() -> bool,
        after_snapshot: impl FnOnce(),
    ) -> Result<FlowFilterBatchResult> {
        if is_cancelled() {
            return Ok(FlowFilterBatchResult {
                cancelled: true,
                filters: Vec::new(),
            });
        }

        let compiled: Vec<(HashSet<&str>, Vec<CompiledFlowFilterTerm>)> = filters
            .iter()
            .map(|filter| {
                let candidates = filter.candidates.iter().map(String::as_str).collect();
                let terms = filter
                    .terms
                    .iter()
                    .map(|term| CompiledFlowFilterTerm {
                        field: term.field,
                        side: term.side,
                        pattern: FlowFilterPattern::new(&term.value, term.regex),
                        neg: term.neg,
                    })
                    .collect();
                (candidates, terms)
            })
            .collect();
        let mut requested_ids = Vec::new();
        let mut requested_seen = HashSet::new();
        for filter in filters {
            for id in &filter.candidates {
                if requested_seen.insert(id.as_str()) {
                    requested_ids.push(id.as_str());
                }
            }
        }
        let snapshot = {
            let store =
                self.shared.store.lock().map_err(|_| {
                    anyhow!("flow store lock poisoned while taking filter snapshot")
                })?;
            requested_ids
                .iter()
                .filter_map(|id| store.get(id).cloned().map(|flow| (*id, flow)))
                .collect::<Vec<_>>()
        };
        after_snapshot();
        if is_cancelled() {
            return Ok(FlowFilterBatchResult {
                cancelled: true,
                filters: Vec::new(),
            });
        }

        let mut hits = vec![HashSet::<String>::new(); filters.len()];
        for (id, flow) in snapshot {
            if is_cancelled() {
                return Ok(FlowFilterBatchResult {
                    cancelled: true,
                    filters: Vec::new(),
                });
            }
            for index in evaluate_flow_filters(&flow, id, &compiled) {
                hits[index].insert(id.to_string());
            }
            if is_cancelled() {
                return Ok(FlowFilterBatchResult {
                    cancelled: true,
                    filters: Vec::new(),
                });
            }
        }
        let results = filters
            .iter()
            .zip(hits)
            .map(|(filter, hits)| {
                let mut seen = HashSet::new();
                FlowFilterMatches {
                    key: filter.key.clone(),
                    matched: filter
                        .candidates
                        .iter()
                        .filter(|id| seen.insert(id.as_str()) && hits.contains(id.as_str()))
                        .cloned()
                        .collect(),
                }
            })
            .collect();
        Ok(FlowFilterBatchResult {
            cancelled: false,
            filters: results,
        })
    }

    /// Whether two flows' bodies are byte-identical, per side, for the compare
    /// view (issue #86). Bodies are compared in decoded form — the same
    /// projection the inspector and the diff display — with an undecodable body
    /// falling back to its raw bytes, so a gzip response and an identity
    /// response with the same content compare equal (the Content-Encoding
    /// header difference still shows in the headers diff). `None` when either
    /// id is unknown.
    pub fn compare_bodies(&self, id_a: &str, id_b: &str) -> Option<BodyComparison> {
        let store = self.shared.store.lock().ok()?;
        let a = store.get(id_a)?;
        let b = store.get(id_b)?;
        let request_equal = body::decoded_or_raw(&a.request.headers, &a.request.body)
            == body::decoded_or_raw(&b.request.headers, &b.request.body);
        let response_equal = match (&a.response, &b.response) {
            (Some(ra), Some(rb)) => Some(
                body::decoded_or_raw(&ra.headers, &ra.body)
                    == body::decoded_or_raw(&rb.headers, &rb.body),
            ),
            _ => None,
        };
        Some(BodyComparison {
            request_equal,
            response_equal,
        })
    }

    /// Shared scan core for body/header/cookie content search. `extract`
    /// projects a message (body + headers) to one or more searchable text units,
    /// or `None` to skip that message (e.g. a binary body). Per flow the request
    /// side wins first, then the response, matching the original `search_bodies`
    /// short-circuit.
    /// Scans a snapshot: flows are cloned out under the store lock (cheap —
    /// `Bytes` bodies are refcounted) and decoded/matched with it RELEASED, so a
    /// big search never stalls live capture.
    fn search_messages(
        &self,
        pattern: &str,
        side: SearchSide,
        regex: bool,
        candidates: Option<&[String]>,
        extract: impl Fn(SearchSide, &[u8], &[(String, String)]) -> Option<Vec<String>>,
    ) -> Vec<String> {
        if pattern.is_empty() {
            return candidates.map(|c| c.to_vec()).unwrap_or_default();
        }
        let re = if regex {
            match regex::RegexBuilder::new(pattern)
                .case_insensitive(true)
                .build()
            {
                Ok(re) => Some(re),
                Err(_) => return Vec::new(),
            }
        } else {
            None
        };
        let needle = pattern.to_lowercase();

        let snapshot: Vec<crate::flow::Flow> = {
            let Ok(store) = self.shared.store.lock() else {
                return Vec::new();
            };
            match candidates {
                Some(c) => c.iter().filter_map(|id| store.get(id).cloned()).collect(),
                None => store.all_flows(),
            }
        };

        let hit = |message_side: SearchSide, body: &[u8], headers: &[(String, String)]| -> bool {
            let Some(texts) = extract(message_side, body, headers) else {
                return false;
            };
            texts.into_iter().any(|text| match &re {
                Some(re) => re.is_match(&text),
                None => text.to_lowercase().contains(&needle),
            })
        };

        snapshot
            .into_iter()
            .filter(|flow| {
                let req = matches!(side, SearchSide::Request | SearchSide::Either)
                    && hit(
                        SearchSide::Request,
                        &flow.request.body,
                        &flow.request.headers,
                    );
                let resp = !req
                    && matches!(side, SearchSide::Response | SearchSide::Either)
                    && flow
                        .response
                        .as_ref()
                        .is_some_and(|r| hit(SearchSide::Response, &r.body, &r.headers));
                req || resp
            })
            .map(|flow| flow.id)
            .collect()
    }

    // ---- capture files: open (.har / .saz) + HAR export ----

    fn next_capture_import_locked(imports: &mut CaptureImportOperations) -> CaptureImportHandle {
        imports.last_id = imports
            .last_id
            .checked_add(1)
            .expect("capture import operation id exhausted");
        CaptureImportHandle {
            id: imports.last_id,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Reserve global ownership before any picker, frontend file read, or
    /// other operation-specific work. A later reservation supersedes this one
    /// even if the earlier import command has not reached Rust yet. Reserving
    /// alone does not disturb an already-running import; only a successful
    /// claim does, so an empty mailbox or cancelled picker is a no-op.
    pub fn reserve_capture_import(&self) -> u64 {
        let mut imports = self
            .capture_imports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = Self::next_capture_import_locked(&mut imports);
        if let Some(previous) = imports.pending.replace(handle.clone()) {
            previous.cancelled.store(true, Ordering::Release);
        }
        handle.id
    }

    /// Attach exactly one import command to a prior reservation. A stale token
    /// cannot become newest merely because its picker or IPC call arrived late.
    pub fn claim_capture_import(&self, id: u64) -> Result<CaptureImportHandle> {
        let mut imports = self
            .capture_imports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(pending) = imports
            .pending
            .take_if(|pending| pending.id == id && !pending.is_cancelled())
        else {
            bail!(CAPTURE_IMPORT_CANCELLED);
        };
        if let Some(previous) = imports.active.replace(pending.clone()) {
            previous.cancelled.store(true, Ordering::Release);
        }
        Ok(pending)
    }

    /// Start a capture import directly. Core callers that do not have a
    /// frontend preflight receive an already-claimed handle; a newer start
    /// still supersedes any parser that has not committed yet.
    pub fn start_capture_import(&self) -> CaptureImportHandle {
        let mut imports = self
            .capture_imports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = Self::next_capture_import_locked(&mut imports);
        if let Some(pending) = imports.pending.take() {
            pending.cancelled.store(true, Ordering::Release);
        }
        if let Some(previous) = imports.active.replace(handle.clone()) {
            previous.cancelled.store(true, Ordering::Release);
        }
        handle
    }

    /// Request cancellation for exactly one pending or active import id. Stale
    /// UI from an older operation cannot accidentally cancel its replacement.
    pub fn cancel_capture_import(&self, id: u64) -> bool {
        let mut imports = self
            .capture_imports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(pending) = imports.pending.take_if(|pending| pending.id == id) {
            pending.cancelled.store(true, Ordering::Release);
            return true;
        }
        if let Some(active) = imports.active.as_ref().filter(|active| active.id == id) {
            active.cancelled.store(true, Ordering::Release);
            return true;
        }
        false
    }

    /// Clear a started handle that failed before parser entry (for example a
    /// file read error). This is id-scoped, so late cleanup cannot clear a newer
    /// active operation.
    pub fn finish_capture_import(&self, handle: &CaptureImportHandle) {
        let mut imports = self
            .capture_imports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if imports
            .active
            .as_ref()
            .is_some_and(|active| active.id == handle.id)
        {
            imports.active = None;
        }
    }

    fn capture_import_is_current(&self, handle: &CaptureImportHandle) -> bool {
        !handle.is_cancelled()
            && self
                .capture_imports
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .as_ref()
                .is_some_and(|active| active.id == handle.id)
    }

    /// Parse a capture file — a HAR or a Fiddler SAZ archive — into flows,
    /// dispatched on the lowercased `ext`.
    fn parse_capture(
        bytes: &[u8],
        ext: &str,
        progress: &mut dyn FnMut(CaptureImportProgress) -> bool,
    ) -> Result<import::ParsedCapture> {
        match ext {
            "har" => import::parse_har_with_progress(bytes, progress),
            "saz" => import::parse_saz_with_progress(bytes, progress),
            other => bail!("Unsupported file type: .{other}"),
        }
    }

    /// Parse and atomically commit a capture started by
    /// [`Self::start_capture_import`]. Parsing and body work remain outside all
    /// store locks. The still-current handle is checked again under the
    /// operation lock immediately before mutation, closing the overlap race.
    pub fn run_capture_import(
        &self,
        handle: &CaptureImportHandle,
        bytes: &[u8],
        ext: &str,
        replace: bool,
        mut on_progress: impl FnMut(CaptureImportProgress) -> bool,
    ) -> Result<CaptureImportResult> {
        let result = (|| {
            if !self.capture_import_is_current(handle) {
                bail!(CAPTURE_IMPORT_CANCELLED);
            }
            let mut parser_progress =
                |progress| self.capture_import_is_current(handle) && on_progress(progress);
            let parsed = Self::parse_capture(bytes, ext, &mut parser_progress)?;
            if !self.capture_import_is_current(handle) {
                bail!(CAPTURE_IMPORT_CANCELLED);
            }

            let total = parsed.flows.len();
            if !on_progress(CaptureImportProgress {
                stage: CaptureImportStage::Finalizing,
                completed: 0,
                total: Some(total as u64),
                cancelable: false,
            }) {
                bail!(CAPTURE_IMPORT_CANCELLED);
            }

            let mut imports = self
                .capture_imports
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if handle.is_cancelled()
                || imports
                    .active
                    .as_ref()
                    .is_none_or(|active| active.id != handle.id)
            {
                bail!(CAPTURE_IMPORT_CANCELLED);
            }

            let summaries = if replace {
                let _history_op = self
                    .shared
                    .history_ops
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Ok(mut history) = self.shared.history.lock() {
                    history.discard_flow_entries();
                }
                self.shared
                    .import_flows_with_progress(parsed.flows, true, |completed, total| {
                        let _ = on_progress(CaptureImportProgress {
                            stage: CaptureImportStage::Finalizing,
                            completed: completed as u64,
                            total: Some(total as u64),
                            cancelable: false,
                        });
                    })
            } else {
                self.shared
                    .import_flows_with_progress(parsed.flows, false, |completed, total| {
                        let _ = on_progress(CaptureImportProgress {
                            stage: CaptureImportStage::Finalizing,
                            completed: completed as u64,
                            total: Some(total as u64),
                            cancelable: false,
                        });
                    })
            };
            imports.active = None;
            Ok(CaptureImportResult {
                summaries,
                embedded_rules: parsed.embedded_rules,
            })
        })();
        self.finish_capture_import(handle);
        result
    }

    /// Open a capture file, REPLACING the current traffic. Returns the number
    /// of flows loaded. The file is fully parsed before anything is cleared,
    /// so a malformed file leaves traffic intact.
    pub fn open_capture(&self, bytes: &[u8], ext: &str) -> Result<usize> {
        let handle = self.start_capture_import();
        Ok(self
            .run_capture_import(&handle, bytes, ext, true, |_| true)?
            .summaries
            .len())
    }

    /// Append a capture file to the current traffic WITHOUT clearing it — for
    /// loading a reference session into the compare view's right side (issue
    /// #86). Appended flows carry the `imported` marker and request numbering
    /// continues (only a replacing open renumbers from 1). Returns the new
    /// flows' summaries in file order, so the caller can address exactly them.
    pub fn append_capture(&self, bytes: &[u8], ext: &str) -> Result<Vec<FlowSummary>> {
        let handle = self.start_capture_import();
        Ok(self
            .run_capture_import(&handle, bytes, ext, false, |_| true)?
            .summaries)
    }

    /// Serialize the current traffic to a HAR 1.2 archive (JSON bytes). With
    /// `include_rules`, the scenarios currently shaping traffic ride along in
    /// the `_germiRules` extension field.
    pub fn export_har(&self, include_rules: bool) -> Vec<u8> {
        let flows = self
            .shared
            .store
            .lock()
            .map(|s| s.all_flows())
            .unwrap_or_default();
        let rules = include_rules
            .then(|| self.mocking_scenarios())
            .filter(|r| !r.is_empty());
        har_export::export_har(&flows, rules.as_deref())
    }

    /// The scenarios evaluated against live traffic right now — the active
    /// scenario plus the General layer when it's on — skipping any without
    /// rules, so an export never embeds an empty bundle.
    fn mocking_scenarios(&self) -> Vec<Scenario> {
        let ar = self.get_autoresponder();
        ar.scenarios
            .iter()
            .filter(|s| !s.rules.is_empty())
            .filter(|s| {
                if s.id == GENERAL_SCENARIO_ID {
                    ar.general_active
                } else {
                    ar.active_scenario_id.as_deref() == Some(s.id.as_str())
                }
            })
            .cloned()
            .collect()
    }

    // ---- autoresponder rules export / import (rules-only HAR) ----

    /// Serialize scenarios to a portable rules file: a HAR with zero entries
    /// whose `_germiRules` field carries the bundle — one format for traffic
    /// and rules alike, and any HTTP tool opens it as an (empty) capture. With
    /// `Some(id)` only that scenario is exported (an empty bundle if it's not
    /// found); `None` exports the whole config. The active-scenario pointer is
    /// never carried.
    pub fn export_rules(&self, scenario_id: Option<&str>) -> Vec<u8> {
        let ar = self.get_autoresponder();
        let selected: Vec<Scenario> = match scenario_id {
            Some(id) => ar.scenarios.into_iter().filter(|s| s.id == id).collect(),
            None => ar.scenarios,
        };
        har_export::export_har(&[], Some(&selected))
    }

    /// Import scenarios from a rules file — a HAR carrying `_germiRules`, a
    /// Fiddler Classic FARX export, or a legacy bare `.germi-rules` bundle.
    /// Imported scenarios are
    /// always re-keyed (fresh scenario + rule ids) so they can never alias an
    /// existing rule's hit counter. `replace == false` appends them (active
    /// pointer preserved); `replace == true` clears existing scenarios and resets
    /// the active pointer to Off (importing must not silently start mocking).
    /// Returns the number of scenarios imported.
    pub fn import_rules(&self, bytes: &[u8], replace: bool) -> Result<usize> {
        self.import_rules_with_general(bytes, replace, GeneralRulesImportMode::AsScenario)
    }

    /// Import scenarios with an explicit destination for a source General
    /// layer. Ordinary scenarios still append or replace according to
    /// `replace`; General can remain an ordinary scenario (legacy behavior),
    /// merge into the built-in layer, or replace that layer's rules.
    pub fn import_rules_with_general(
        &self,
        bytes: &[u8],
        replace: bool,
        general_mode: GeneralRulesImportMode,
    ) -> Result<usize> {
        let imported = rules_export::parse_rules_with_origins(bytes)?;
        let count = imported.len();

        let mut ar = self.get_autoresponder();
        if replace {
            // Replace swaps out the switchable scenarios, but the General layer
            // is a persistent cross-cutting layer — not one of the replaceable
            // scenarios — so preserve its rules across the replace.
            let general = ar.general().cloned();
            ar.scenarios.clear();
            ar.active_scenario_id = None;
            if let Some(general) = general {
                ar.scenarios.push(general);
            }
        }
        // The merge/replace destinations and the name de-duplication set both
        // need the canonical built-in layer to exist before imported scenarios
        // are routed.
        ar.ensure_general();
        let mut taken: std::collections::HashSet<String> =
            ar.scenarios.iter().map(|s| s.name.clone()).collect();
        let mut imported_general_rules = Vec::new();
        let mut saw_general = false;
        for imported in imported {
            let mut scenario = imported.scenario;
            if imported.was_general && general_mode != GeneralRulesImportMode::AsScenario {
                saw_general = true;
                imported_general_rules.append(&mut scenario.rules);
                continue;
            }
            scenario.name = rules_export::dedupe_name(&mut taken, &scenario.name);
            ar.scenarios.push(scenario);
        }

        if saw_general {
            let general = ar
                .scenarios
                .iter_mut()
                .find(|scenario| scenario.id == GENERAL_SCENARIO_ID)
                .expect("ensure_general seeded the destination");
            match general_mode {
                GeneralRulesImportMode::Merge => {
                    general.rules.append(&mut imported_general_rules);
                }
                GeneralRulesImportMode::Replace => {
                    general.rules = imported_general_rules;
                }
                GeneralRulesImportMode::AsScenario => unreachable!("handled above"),
            }
        }

        // Guarantee the built-in General scenario exists and stays first, even
        // when neither the current config nor the bundle carried one.
        ar.ensure_general();
        self.set_autoresponder(ar);
        Ok(count)
    }

    // ---- autoresponder (scenarios) access ----

    pub fn get_autoresponder(&self) -> AutoResponder {
        self.shared
            .autoresponder
            .read()
            .map(|ar| ar.clone())
            .unwrap_or_default()
    }

    pub fn autoresponder_summary(&self) -> AutoResponderSummary {
        self.shared
            .autoresponder
            .read()
            .map(|ar| AutoResponderSummary::from(&*ar))
            .unwrap_or_default()
    }

    pub fn get_rule(&self, rule_id: &str) -> Option<Rule> {
        self.shared.autoresponder.read().ok().and_then(|ar| {
            ar.scenarios
                .iter()
                .flat_map(|scenario| &scenario.rules)
                .find(|rule| rule.id == rule_id)
                .cloned()
        })
    }

    /// Deep rule search within one scenario. Returns the ids of rules whose
    /// `scope` fields contain `pattern` (case-insensitive substring; no regex).
    /// An empty `pattern` returns every rule id in the scenario; a missing
    /// scenario returns empty.
    pub fn search_rules(
        &self,
        scenario_id: &str,
        pattern: &str,
        scope: RuleSearchScope,
    ) -> Vec<String> {
        let Ok(ar) = self.shared.autoresponder.read() else {
            return Vec::new();
        };
        let Some(scenario) = ar.scenarios.iter().find(|s| s.id == scenario_id) else {
            return Vec::new();
        };
        if pattern.is_empty() {
            return scenario.rules.iter().map(|rule| rule.id.clone()).collect();
        }
        let needle = pattern.to_lowercase();
        scenario
            .rules
            .iter()
            .filter(|rule| rules::rule_matches_scope(rule, scope, &needle))
            .map(|rule| rule.id.clone())
            .collect()
    }

    pub fn test_scenario(&self, scenario_id: &str, input: &TestInput) -> Result<TestResult> {
        let autoresponder = self
            .shared
            .autoresponder
            .read()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = autoresponder
            .scenarios
            .iter()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        Ok(tester::test_rule_slice(&scenario.rules, input))
    }

    pub fn set_autoresponder(&self, autoresponder: AutoResponder) {
        let new_active = autoresponder.active_scenario_id.clone();
        // Both the General layer and the active scenario are evaluated, so both
        // hold meaningful cursors — scope retention to that combined set (which
        // also drops General's cursors when the layer is toggled off, since
        // `evaluated_rule_ids` omits them then).
        let live: std::collections::HashSet<String> = autoresponder
            .evaluated_rule_ids()
            .iter()
            .map(|id| (*id).to_string())
            .collect();

        let Ok(mut ar) = self.shared.autoresponder.write() else {
            return;
        };
        let prev_active = ar.active_scenario_id.clone();
        *ar = autoresponder;
        // Reset cursors while still holding the autoresponder write lock so the
        // swap + reset are atomic against an in-flight request (which takes the
        // read lock then cursors, in that order — so this never deadlocks).
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            if prev_active == new_active {
                let live_refs: std::collections::HashSet<&str> =
                    live.iter().map(String::as_str).collect();
                cursors.reset_missing(&live_refs);
            } else {
                cursors.reset();
            }
        }
    }

    fn reconcile_rule_cursors(&self, previous_active: Option<&str>, autoresponder: &AutoResponder) {
        let live = autoresponder.evaluated_rule_ids();
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            if previous_active == autoresponder.active_scenario_id.as_deref() {
                cursors.reset_missing(&live);
            } else {
                cursors.reset();
            }
        }
    }

    pub fn set_active_scenario(&self, scenario_id: Option<&str>) -> Result<()> {
        if scenario_id == Some(GENERAL_SCENARIO_ID) {
            return Err(anyhow!(
                "the built-in General scenario cannot be the active scenario"
            ));
        }
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        if scenario_id.is_some_and(|id| !ar.scenarios.iter().any(|scenario| scenario.id == id)) {
            return Err(anyhow!("scenario not found"));
        }
        let previous_active = ar.active_scenario_id.clone();
        ar.active_scenario_id = scenario_id.map(str::to_string);
        self.reconcile_rule_cursors(previous_active.as_deref(), &ar);
        Ok(())
    }

    /// Toggle the built-in General layer on/off. Independent of the active
    /// scenario, so General + one scenario can be live together. Resets cursors
    /// (the set of evaluated rules changes).
    pub fn set_general_active(&self, active: bool) -> Result<()> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        ar.general_active = active;
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            cursors.reset();
        }
        Ok(())
    }

    pub fn create_scenario(&self, name: Option<&str>) -> Result<ScenarioSummary> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let id = new_entity_id("scenario");
        let scenario = Scenario {
            id,
            name: name.map_or_else(
                || {
                    // The built-in General layer is not a numbered scenario.
                    // Continue after the largest existing generated name so a
                    // fresh document starts at Scenario 1 and deleting an
                    // earlier scenario cannot create a duplicate label.
                    let next = ar
                        .scenarios
                        .iter()
                        .filter_map(|scenario| {
                            scenario
                                .name
                                .strip_prefix("Scenario ")
                                .and_then(|suffix| suffix.parse::<u64>().ok())
                        })
                        .max()
                        .unwrap_or(0)
                        .saturating_add(1);
                    format!("Scenario {next}")
                },
                str::to_string,
            ),
            rules: Vec::new(),
        };
        let summary = ScenarioSummary::from(&scenario);
        ar.active_scenario_id = Some(scenario.id.clone());
        ar.scenarios.push(scenario);
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            cursors.reset();
        }
        Ok(summary)
    }

    pub fn rename_scenario(&self, scenario_id: &str, name: String) -> Result<()> {
        if scenario_id == GENERAL_SCENARIO_ID {
            return Err(anyhow!("the built-in General scenario cannot be renamed"));
        }
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        scenario.name = name;
        Ok(())
    }

    pub fn delete_scenario(&self, scenario_id: &str) -> Result<()> {
        if scenario_id == GENERAL_SCENARIO_ID {
            return Err(anyhow!("the built-in General scenario cannot be deleted"));
        }
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let previous_active = ar.active_scenario_id.clone();
        let before = ar.scenarios.len();
        ar.scenarios.retain(|scenario| scenario.id != scenario_id);
        if ar.scenarios.len() == before {
            return Err(anyhow!("scenario not found"));
        }
        if ar.active_scenario_id.as_deref() == Some(scenario_id) {
            ar.active_scenario_id = None;
        }
        self.reconcile_rule_cursors(previous_active.as_deref(), &ar);
        Ok(())
    }

    pub fn create_rule(&self, scenario_id: &str) -> Result<(Rule, RuleSummary)> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let rule = rules::blank_rule(new_entity_id("rule"));
        let summary = RuleSummary::from(&rule);
        scenario.rules.push(rule.clone());
        Ok((rule, summary))
    }

    pub fn update_rule(&self, scenario_id: &str, rule: Rule) -> Result<RuleSummary> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let slot = scenario
            .rules
            .iter_mut()
            .find(|candidate| candidate.id == rule.id)
            .ok_or_else(|| anyhow!("rule not found"))?;
        *slot = rule;
        let summary = RuleSummary::from(&*slot);
        Ok(summary)
    }

    pub fn delete_rule(&self, scenario_id: &str, rule_id: &str) -> Result<()> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let previous_active = ar.active_scenario_id.clone();
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let before = scenario.rules.len();
        scenario.rules.retain(|rule| rule.id != rule_id);
        if scenario.rules.len() == before {
            return Err(anyhow!("rule not found"));
        }
        self.reconcile_rule_cursors(previous_active.as_deref(), &ar);
        Ok(())
    }

    /// Delete several rules from a scenario in one shot (multi-select delete).
    /// Ids that aren't present are skipped rather than aborting the batch — a
    /// stale selection shouldn't leave the delete half-applied — and the count of
    /// rules actually removed is returned so the caller can label the undo step.
    /// Wrapping the whole batch in a single [`with_history`](Self::with_history)
    /// makes it one undo entry.
    pub fn delete_rules(&self, scenario_id: &str, rule_ids: &[String]) -> Result<usize> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let previous_active = ar.active_scenario_id.clone();
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let doomed: HashSet<&str> = rule_ids.iter().map(String::as_str).collect();
        let before = scenario.rules.len();
        scenario
            .rules
            .retain(|rule| !doomed.contains(rule.id.as_str()));
        let removed = before - scenario.rules.len();
        if removed > 0 {
            self.reconcile_rule_cursors(previous_active.as_deref(), &ar);
        }
        Ok(removed)
    }

    pub fn duplicate_rule(&self, scenario_id: &str, rule_id: &str) -> Result<(Rule, RuleSummary)> {
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let index = scenario
            .rules
            .iter()
            .position(|rule| rule.id == rule_id)
            .ok_or_else(|| anyhow!("rule not found"))?;
        let mut copy = scenario.rules[index].clone();
        copy.id = new_entity_id("rule");
        let summary = RuleSummary::from(&copy);
        scenario.rules.insert(index + 1, copy.clone());
        Ok((copy, summary))
    }

    pub fn reorder_rule(
        &self,
        scenario_id: &str,
        rule_id: &str,
        to_id: &str,
    ) -> Result<(Option<String>, Option<String>)> {
        if rule_id == to_id {
            return Ok((None, None));
        }
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let from = scenario
            .rules
            .iter()
            .position(|rule| rule.id == rule_id)
            .ok_or_else(|| anyhow!("rule not found"))?;
        let to = scenario
            .rules
            .iter()
            .position(|rule| rule.id == to_id)
            .ok_or_else(|| anyhow!("target rule not found"))?;
        let rule = scenario.rules.remove(from);
        scenario.rules.insert(to, rule);
        let index = scenario
            .rules
            .iter()
            .position(|rule| rule.id == rule_id)
            .ok_or_else(|| anyhow!("rule not found after reorder"))?;
        let previous = index
            .checked_sub(1)
            .and_then(|previous| scenario.rules.get(previous))
            .map(|rule| rule.id.clone());
        let next = scenario.rules.get(index + 1).map(|rule| rule.id.clone());
        Ok((previous, next))
    }

    pub fn reset_rule_state(&self, scenario_id: Option<&str>) {
        let ids: Vec<String> = match scenario_id {
            None => Vec::new(),
            Some(id) => self
                .shared
                .autoresponder
                .read()
                .ok()
                .and_then(|ar| {
                    ar.scenarios
                        .iter()
                        .find(|s| s.id == id)
                        .map(|s| s.rules.iter().map(|r| r.id.clone()).collect())
                })
                .unwrap_or_default(),
        };
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            match scenario_id {
                None => cursors.reset(),
                Some(_) => {
                    for rid in &ids {
                        cursors.reset_rule(rid);
                    }
                }
            }
        }
    }

    pub fn rule_hits(&self) -> std::collections::HashMap<String, u32> {
        self.shared
            .cursors
            .lock()
            .map(|c| c.snapshot())
            .unwrap_or_default()
    }

    // ---- proxy settings (host exclusions) ----

    pub fn get_settings(&self) -> ProxySettings {
        self.shared
            .settings
            .read()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    /// Replace the live settings. Takes effect immediately for new connections
    /// (excluded hosts begin tunneling without restarting the proxy); the flow
    /// retention cap is re-applied to the store.
    pub fn set_settings(&self, settings: ProxySettings) {
        let max = settings.max_flows;
        if let Ok(mut guard) = self.shared.settings.write() {
            *guard = settings;
        }
        if let Ok(mut store) = self.shared.store.lock() {
            let evicted = store.set_max(max);
            if !evicted.is_empty() {
                let _ = self.shared.events.send(FlowEvent::Removed { ids: evicted });
            }
        }
    }

    // ---- user scripts (request/response hooks) ----

    /// The stored scripts (source and all), in order.
    pub fn get_scripts(&self) -> Vec<Script> {
        self.shared
            .scripts
            .read()
            .map(|engine| engine.scripts())
            .unwrap_or_default()
    }

    /// Replace the whole script set (compiling each) and take effect immediately
    /// for new traffic. Returns a compile diagnostic per script so the editor can
    /// flag the ones that failed. Persistence is the Tauri layer's concern.
    pub fn set_scripts(&self, scripts: Vec<Script>) -> Vec<ScriptDiagnostic> {
        match self.shared.scripts.write() {
            Ok(mut engine) => engine.set_scripts(scripts),
            Err(_) => Vec::new(),
        }
    }

    /// Compile `source` without storing it; `Some(message)` if it doesn't compile.
    pub fn check_script(&self, source: &str) -> Option<String> {
        self.shared
            .scripts
            .read()
            .ok()
            .and_then(|engine| engine.check(source))
    }

    /// Build mock rules without changing live state. Callers can report progress,
    /// persist the batch transactionally, then commit it atomically.
    pub fn prepare_mock_flows(
        &self,
        ids: &[String],
        scenario_id: Option<&str>,
        mut on_progress: impl FnMut(usize, usize),
    ) -> MockBatch {
        let flows: Vec<Option<crate::flow::Flow>> = match self.shared.store.lock() {
            Ok(store) => ids.iter().map(|id| store.get(id).cloned()).collect(),
            Err(_) => Vec::new(),
        };
        let mut rules = Vec::with_capacity(flows.len());
        for (index, flow) in flows.into_iter().enumerate() {
            if let Some(flow) = flow {
                rules.push(rules::respond_rule_from_flow(&flow, new_entity_id("rule")));
            }
            on_progress(index + 1, ids.len());
        }

        let ar = self.get_autoresponder();
        let scenario_id = scenario_id
            .map(str::to_string)
            .or(ar.active_scenario_id)
            .unwrap_or_else(|| new_entity_id("scenario"));
        let create_scenario = !ar
            .scenarios
            .iter()
            .any(|scenario| scenario.id == scenario_id);
        MockBatch {
            scenario_id,
            scenario_name: "My mocks".to_string(),
            create_scenario,
            rules,
        }
    }

    pub fn commit_mock_batch(&self, batch: MockBatch) -> Result<MockResult> {
        if batch.rules.is_empty() {
            return Ok(MockResult {
                scenario_id: batch.scenario_id,
                new_rule_ids: Vec::new(),
            });
        }
        let mut ar = self
            .shared
            .autoresponder
            .write()
            .map_err(|_| anyhow!("autoresponder lock poisoned"))?;
        let previous_active = ar.active_scenario_id.clone();
        if batch.create_scenario {
            ar.scenarios.push(Scenario {
                id: batch.scenario_id.clone(),
                name: batch.scenario_name,
                rules: Vec::new(),
            });
        }
        let scenario = ar
            .scenarios
            .iter_mut()
            .find(|scenario| scenario.id == batch.scenario_id)
            .ok_or_else(|| anyhow!("scenario not found"))?;
        let new_rule_ids = batch.rules.iter().map(|rule| rule.id.clone()).collect();
        scenario.rules.reserve(batch.rules.len());
        scenario.rules.extend(batch.rules);
        // General is an independently-toggleable layer, never the switchable
        // active scenario. Dropping flows onto it must preserve the user's
        // currently active ordinary scenario.
        if batch.scenario_id != GENERAL_SCENARIO_ID {
            ar.active_scenario_id = Some(batch.scenario_id.clone());
        }
        self.reconcile_rule_cursors(previous_active.as_deref(), &ar);
        Ok(MockResult {
            scenario_id: batch.scenario_id,
            new_rule_ids,
        })
    }

    /// Compatibility helper for engine callers that do not need persistence or
    /// progress events.
    pub fn mock_flows(&self, ids: &[String], scenario_id: Option<&str>) -> MockResult {
        let batch = self.prepare_mock_flows(ids, scenario_id, |_, _| {});
        self.commit_mock_batch(batch)
            .unwrap_or_else(|_| MockResult {
                scenario_id: scenario_id.unwrap_or_default().to_string(),
                new_rule_ids: Vec::new(),
            })
    }

    // ---- undo / redo history ----

    /// Run a mock-document mutation and record it as a single undo entry,
    /// capturing before/after snapshots of the whole autoresponder. A mutation
    /// that changes nothing — or fails — records no entry. `tag` carries the UI
    /// label and the coalescing key (consecutive same-key edits merge).
    pub fn with_history<T, E>(
        &self,
        tag: HistoryTag,
        mutation: impl FnOnce(&Self) -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = self.get_autoresponder();
        let before_cursors = self
            .shared
            .cursors
            .lock()
            .ok()
            .map(|cursors| cursors.snapshot());
        let result = match mutation(self) {
            Ok(result) => result,
            Err(error) => {
                // Callers deliberately keep their persistence write inside this
                // serialized closure. If that write fails after the live engine
                // changed, restore the snapshot so the rejected command is not
                // memory-only, invisible to undo, and lost on restart.
                if self.get_autoresponder() != before {
                    self.set_autoresponder(before);
                }
                if let (Some(snapshot), Ok(mut cursors)) =
                    (before_cursors, self.shared.cursors.lock())
                {
                    cursors.restore(snapshot);
                }
                return Err(error);
            }
        };
        let after = self.get_autoresponder();
        if before != after {
            if let Ok(mut history) = self.shared.history.lock() {
                history.record(HistoryOp::Mock { before, after }, tag);
            }
        }
        Ok(result)
    }

    /// Like [`remove_flows`](Self::remove_flows), but records the removal so it
    /// can be undone — the removed flows (bodies and capture positions) are held
    /// in the history entry.
    pub fn remove_flows_tracked(&self, ids: &[String]) {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let items = match self.shared.store.lock() {
            Ok(mut store) => {
                let items = store.remove_capturing(ids);
                if !items.is_empty() {
                    let removed_ids: Vec<String> =
                        items.iter().map(|(_, flow)| flow.id.clone()).collect();
                    let _ = self
                        .shared
                        .events
                        .send(FlowEvent::Removed { ids: removed_ids });
                }
                items
            }
            Err(_) => Vec::new(),
        };
        if items.is_empty() {
            return;
        }
        let label = format!(
            "Delete {} flow{}",
            items.len(),
            if items.len() == 1 { "" } else { "s" }
        );
        if let Ok(mut history) = self.shared.history.lock() {
            history.record(
                HistoryOp::FlowsRemoved { items },
                HistoryTag::new(label, None),
            );
        }
    }

    /// Remove every live-captured (non-imported) flow, keeping the flows that were
    /// loaded from a file (HAR / SAZ). This is the "clear the replay
    /// noise, keep the imported reference" action: while replaying an imported
    /// session, captured traffic piles up, and this prunes exactly that (issue
    /// #49). Recorded on the undo timeline; a no-op when nothing is captured.
    pub fn remove_captured_flows(&self) {
        let ids = match self.shared.store.lock() {
            Ok(store) => store.ids_where(|flow| !flow.imported),
            Err(_) => Vec::new(),
        };
        self.remove_flows_tracked(&ids);
    }

    /// Like [`clear_flows`](Self::clear_flows), but records the cleared snapshot
    /// so it can be undone.
    pub fn clear_flows_tracked(&self) {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let flows = match self.shared.store.lock() {
            Ok(mut store) => {
                let all = store.all_flows();
                store.clear();
                let _ = self.shared.events.send(FlowEvent::Cleared);
                all
            }
            Err(_) => Vec::new(),
        };
        if flows.is_empty() {
            return;
        }
        let label = format!(
            "Clear traffic ({} flow{})",
            flows.len(),
            if flows.len() == 1 { "" } else { "s" }
        );
        if let Ok(mut history) = self.shared.history.lock() {
            history.record(
                HistoryOp::FlowsCleared { flows },
                HistoryTag::new(label, None),
            );
        }
    }

    pub fn clear_history(&self) {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Ok(mut history) = self.shared.history.lock() {
            history.clear();
        }
    }

    /// Undo the newest action. Returns whether the autoresponder changed (so the
    /// caller re-persists it); `None` when there is nothing to undo.
    pub fn undo(&self) -> Option<HistoryStep> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.undo_inner()
    }

    /// Undo while keeping a caller-owned persistence step inside the same
    /// serialized history transaction. The Tauri shell uses this so a newer
    /// mutation cannot be overwritten by a delayed full-document DB rewrite.
    pub fn undo_and_then<E>(
        &self,
        after: impl FnOnce(&Self, &HistoryStep) -> std::result::Result<(), E>,
    ) -> std::result::Result<Option<HistoryStep>, E> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before_cursors = self
            .shared
            .cursors
            .lock()
            .ok()
            .map(|cursors| cursors.snapshot());
        let step = self.undo_inner();
        if let Some(step) = &step {
            if let Err(error) = after(self, step) {
                // `undo_inner` already moved the entry to redo and changed live
                // state. The persistence callback is transactional, so reverse
                // the in-memory transition too before reporting its error.
                let rolled_back = self.redo_inner();
                debug_assert!(rolled_back.is_some(), "failed undo must remain redoable");
                if let (Some(snapshot), Ok(mut cursors)) =
                    (before_cursors, self.shared.cursors.lock())
                {
                    cursors.restore(snapshot);
                }
                return Err(error);
            }
        }
        Ok(step)
    }

    fn undo_inner(&self) -> Option<HistoryStep> {
        let entry = self.shared.history.lock().ok()?.take_undo()?;
        let mock_changed = self.apply_undo(&entry);
        self.shared.history.lock().ok()?.stash_redo(entry);
        Some(HistoryStep { mock_changed })
    }

    /// Redo the most recently undone action.
    pub fn redo(&self) -> Option<HistoryStep> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.redo_inner()
    }

    /// Redo counterpart to [`Self::undo_and_then`].
    pub fn redo_and_then<E>(
        &self,
        after: impl FnOnce(&Self, &HistoryStep) -> std::result::Result<(), E>,
    ) -> std::result::Result<Option<HistoryStep>, E> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before_cursors = self
            .shared
            .cursors
            .lock()
            .ok()
            .map(|cursors| cursors.snapshot());
        let step = self.redo_inner();
        if let Some(step) = &step {
            if let Err(error) = after(self, step) {
                let rolled_back = self.undo_inner();
                debug_assert!(rolled_back.is_some(), "failed redo must remain undoable");
                if let (Some(snapshot), Ok(mut cursors)) =
                    (before_cursors, self.shared.cursors.lock())
                {
                    cursors.restore(snapshot);
                }
                return Err(error);
            }
        }
        Ok(step)
    }

    fn redo_inner(&self) -> Option<HistoryStep> {
        let entry = self.shared.history.lock().ok()?.take_redo()?;
        let mock_changed = self.apply_redo(&entry);
        self.shared.history.lock().ok()?.stash_undo(entry);
        Some(HistoryStep { mock_changed })
    }

    /// Undo or redo until the entry with `entry_id` is the current state (the top
    /// of the applied stack). A no-op when the id isn't in the timeline.
    pub fn jump_to(&self, entry_id: u64) -> Option<HistoryStep> {
        let _history_op = self
            .shared
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut mock_changed = false;
        loop {
            let (is_top, in_undo, in_redo) = {
                let history = self.shared.history.lock().ok()?;
                (
                    history.undo_top_id() == Some(entry_id),
                    history.undo_contains(entry_id),
                    history.redo_contains(entry_id),
                )
            };
            if is_top || (!in_undo && !in_redo) {
                break;
            }
            let step = if in_undo {
                self.undo_inner()
            } else {
                self.redo_inner()
            };
            match step {
                Some(step) => mock_changed |= step.mock_changed,
                None => break,
            }
        }
        Some(HistoryStep { mock_changed })
    }

    fn apply_undo(&self, entry: &HistoryEntry) -> bool {
        match &entry.op {
            HistoryOp::Mock { before, .. } => {
                self.set_autoresponder(before.clone());
                true
            }
            HistoryOp::FlowsRemoved { items } => {
                self.restore_flows(items.clone());
                false
            }
            HistoryOp::FlowsCleared { flows } => {
                self.restore_flows(flows.iter().cloned().enumerate().collect());
                false
            }
        }
    }

    fn apply_redo(&self, entry: &HistoryEntry) -> bool {
        match &entry.op {
            HistoryOp::Mock { after, .. } => {
                self.set_autoresponder(after.clone());
                true
            }
            HistoryOp::FlowsRemoved { items } => {
                let ids: Vec<String> = items.iter().map(|(_, flow)| flow.id.clone()).collect();
                self.remove_flows(&ids);
                false
            }
            HistoryOp::FlowsCleared { flows } => {
                // Redo the original clear, not "clear whatever exists now".
                // Traffic may have arrived after the clear was undone; removing
                // it here would make redo destroy data that was never part of
                // the history entry (and also breaks failed-undo rollback).
                let ids: Vec<String> = flows.iter().map(|flow| flow.id.clone()).collect();
                self.remove_flows(&ids);
                false
            }
        }
    }

    /// Re-insert flows (with their capture positions) and tell the UI to re-list.
    fn restore_flows(&self, items: Vec<(usize, crate::flow::Flow)>) {
        if let Ok(mut store) = self.shared.store.lock() {
            store.restore(items);
            let _ = self.shared.events.send(FlowEvent::Resync);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{CapturedRequest, CapturedResponse};

    fn controller() -> ProxyController {
        ProxyController::new(CertAuthority::generate().expect("generate in-memory CA"))
    }

    /// Scenario names excluding the built-in General layer — the "user"
    /// scenarios the import/merge/replace tests reason about. `import_rules`
    /// always seeds a General scenario, so tests assert on this filtered view.
    fn user_names(ar: &AutoResponder) -> Vec<String> {
        ar.scenarios
            .iter()
            .filter(|s| s.id != GENERAL_SCENARIO_ID)
            .map(|s| s.name.clone())
            .collect()
    }

    fn respond_rule(id: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: Some(1),
            repeat: false,
            matcher: Matcher {
                method: None,
                url: "/seq".to_string(),
                url_match: MatchKind::Contains,
            },
            action: Action::Respond {
                status: 200,
                headers: vec![],
                body: id.to_string(),
                body_base64: None,
                content_type: Some("text/plain".to_string()),
                content_encoding: None,
            },
        }
    }

    fn scenario(id: &str, rules: Vec<Rule>) -> Scenario {
        Scenario {
            id: id.to_string(),
            name: id.to_string(),
            rules,
        }
    }

    fn general_scenario(rules: Vec<Rule>) -> Scenario {
        Scenario {
            id: GENERAL_SCENARIO_ID.to_string(),
            name: GENERAL_SCENARIO_NAME.to_string(),
            rules,
        }
    }

    fn delayed_origin() -> (
        std::net::SocketAddr,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind origin");
        let origin = listener.local_addr().expect("addr");
        let (first_seen_tx, first_seen_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut first_conn = Some((first_seen_tx, release_rx));
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let gate = first_conn.take();
                std::thread::spawn(move || {
                    let mut buf = [0_u8; 2048];
                    let _ = stream.read(&mut buf);
                    if let Some((first_seen, release)) = gate {
                        let _ = first_seen.send(());
                        let _ = release.recv_timeout(std::time::Duration::from_secs(10));
                    }
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    );
                    let _ = stream.flush();
                });
            }
        });
        (origin, first_seen_rx, release_tx)
    }

    fn request() -> CapturedRequest {
        CapturedRequest {
            method: "GET".to_string(),
            uri: "https://example.com/seq".to_string(),
            scheme: "https".to_string(),
            host: "example.com".to_string(),
            path: "/seq".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        }
    }

    fn fire_active_once(controller: &ProxyController) {
        let ar = controller
            .shared
            .autoresponder
            .read()
            .expect("read autoresponder");
        let mut cursors = controller.shared.cursors.lock().expect("lock cursors");
        ar.evaluate_request_stateful(&request(), &mut cursors);
    }

    fn flow(id: &str) -> crate::flow::Flow {
        crate::flow::Flow {
            id: id.to_string(),
            seq: 0,
            request: request(),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        }
    }

    fn completed_flow(id: &str) -> crate::flow::Flow {
        let mut flow = flow(id);
        flow.request.path = format!("/{id}");
        flow.request.uri = format!("https://example.com/{id}");
        flow.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: format!("response-{id}").into_bytes().into(),
            timestamp_ms: 1,
        });
        flow
    }

    fn loopback(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    #[tokio::test]
    async fn bound_addr_tracks_the_live_listener() {
        let c = controller();
        assert_eq!(c.bound_addr().await, None);
        let bound = c.start(loopback(0)).await.expect("start");
        // Reports exactly what's bound (so the UI can re-read it after a reload).
        assert_eq!(c.bound_addr().await, Some(bound));
        let rebound = c.restart(loopback(0)).await.expect("restart");
        assert_eq!(c.bound_addr().await, Some(rebound));
        c.stop().await;
        assert_eq!(c.bound_addr().await, None);
    }

    #[tokio::test]
    async fn finished_serving_task_is_not_reported_as_a_live_proxy() {
        let c = controller();
        let (shutdown, _shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async {});
        tokio::task::yield_now().await;
        assert!(task.is_finished(), "test serving task must have exited");
        *c.running.lock().await = Some((loopback(43210), shutdown, task));

        assert!(!c.is_running().await);
        assert_eq!(c.bound_addr().await, None);
    }

    #[tokio::test]
    async fn shutdown_deadline_aborts_a_serving_task_that_never_drains() {
        let (shutdown, _shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(std::future::pending());
        assert!(
            shutdown_proxy(shutdown, task, Duration::from_millis(5)).await,
            "the controller must force progress after the grace period"
        );
    }

    #[tokio::test]
    async fn restart_rebinds_to_a_new_port() {
        let c = controller();
        let first = c.start(loopback(0)).await.expect("start");
        assert!(c.is_running().await);
        // Rebind to another OS-assigned port. Because the new listener is bound
        // before the old one is released, the OS can't hand back the same port.
        let second = c.restart(loopback(0)).await.expect("restart");
        assert!(c.is_running().await);
        assert_ne!(first.port(), second.port());
        c.stop().await;
        assert!(!c.is_running().await);
    }

    #[tokio::test]
    async fn restart_can_toggle_loopback_and_lan_scope_on_the_same_port() {
        let c = controller();
        let first = c.start(loopback(0)).await.expect("start");
        let lan_addr = SocketAddr::from(([0, 0, 0, 0], first.port()));

        let rebound = c
            .restart(lan_addr)
            .await
            .expect("same-port scope change must rebind");
        assert_eq!(rebound, lan_addr);
        assert_eq!(c.bound_addr().await, Some(lan_addr));

        let local_addr = loopback(first.port());
        let rebound = c
            .restart(local_addr)
            .await
            .expect("scope can be narrowed again");
        assert_eq!(rebound, local_addr);
        assert_eq!(c.bound_addr().await, Some(local_addr));
        c.stop().await;
    }

    #[tokio::test]
    async fn restart_onto_taken_port_keeps_old_proxy_running() {
        let c = controller();
        c.start(loopback(0)).await.expect("start");
        // Occupy a port with a plain listener, then try to rebind onto it.
        let blocker = std::net::TcpListener::bind(loopback(0)).expect("bind blocker");
        let taken = blocker.local_addr().expect("addr");
        assert!(
            c.restart(taken).await.is_err(),
            "rebinding onto an in-use port must fail"
        );
        // The failed rebind left the original proxy serving, not stopped.
        assert!(c.is_running().await);
        c.stop().await;
    }

    /// End-to-end Map Remote (issue #111): a request through the LIVE proxy for
    /// a host that doesn't exist is transparently forwarded to the mapped local
    /// server, with `$1` expanded from the regex matcher, the Host header
    /// rewritten to the new authority, and the rule stamped as Mocked-by.
    #[tokio::test]
    async fn map_remote_forwards_through_the_live_proxy() {
        use std::io::{Read, Write};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // The mapped-to server: records the request head it receives.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mapped server");
        let mapped_addr = listener.local_addr().expect("addr");
        let (head_tx, head_rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = head_tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = s.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nmapped",
                );
                let _ = s.flush();
            }
        });

        let c = controller();
        let mut ar = AutoResponder::default();
        ar.ensure_general();
        ar.scenarios.push(Scenario {
            id: "s".to_string(),
            name: "s".to_string(),
            rules: vec![Rule {
                id: "map".to_string(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher {
                    method: None,
                    url: r".*agent_(\w+)_\d+\.js".to_string(),
                    url_match: MatchKind::Regex,
                },
                action: Action::MapRemote {
                    url: format!("http://{mapped_addr}/ajax/agent_$1_1.js"),
                },
            }],
        });
        ar.active_scenario_id = Some("s".to_string());
        c.set_autoresponder(ar);

        let proxy_addr = c.start(loopback(0)).await.expect("start proxy");

        // Plain-HTTP forward-proxy request for an unresolvable host — only the
        // Map Remote rewrite can produce a 200.
        let mut client = tokio::net::TcpStream::connect(proxy_addr)
            .await
            .expect("connect proxy");
        client
            .write_all(
                b"GET http://origin.invalid/js/agent_A2qru_10240521.js HTTP/1.1\r\n\
                  Host: origin.invalid\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send through proxy");
        let mut response = Vec::new();
        client
            .read_to_end(&mut response)
            .await
            .expect("read response");
        let response = String::from_utf8_lossy(&response);
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "unexpected response: {response}"
        );
        assert!(
            response.ends_with("mapped"),
            "unexpected response: {response}"
        );

        // The mapped server saw the expanded path and its own authority as Host.
        let head = head_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("mapped server was hit");
        assert!(
            head.starts_with("GET /ajax/agent_A2qru_1.js HTTP/1.1"),
            "wire request: {head}"
        );
        assert!(
            head.to_lowercase()
                .contains(&format!("host: {mapped_addr}")),
            "wire request: {head}"
        );

        // The flow records the ORIGINAL URL and the map rule as its provenance.
        let flow = c.list_flows().pop().expect("one captured flow");
        assert_eq!(flow.host, "origin.invalid");
        assert_eq!(flow.matched_rule.as_deref(), Some(r".*agent_(\w+)_\d+\.js"));

        c.stop().await;
    }

    /// A response-phase rule must still apply when the pending flow was evicted
    /// from the bounded store before its response arrived (cap 1, two
    /// overlapping requests): the response path may not depend on re-fetching
    /// the request from the store.
    #[tokio::test]
    async fn response_rules_apply_after_cap_eviction_through_the_live_proxy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // The origin: holds the FIRST request's response until released, so the
        // second capture evicts the first while it's still pending.
        let (origin, first_seen_rx, release_tx) = delayed_origin();

        let c = controller();
        let mut ar = AutoResponder::default();
        ar.ensure_general();
        ar.scenarios.push(Scenario {
            id: "s".to_string(),
            name: "s".to_string(),
            rules: vec![Rule {
                id: "hdr".to_string(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher {
                    method: None,
                    url: "/".to_string(),
                    url_match: MatchKind::Contains,
                },
                action: Action::SetResponseHeader {
                    name: "x-germi-rule".to_string(),
                    value: "on".to_string(),
                },
            }],
        });
        ar.active_scenario_id = Some("s".to_string());
        c.set_autoresponder(ar);
        c.set_settings(ProxySettings {
            max_flows: 1,
            ..Default::default()
        });

        let proxy_addr = c.start(loopback(0)).await.expect("start proxy");

        let mut held_client = tokio::net::TcpStream::connect(proxy_addr)
            .await
            .expect("connect proxy");
        held_client
            .write_all(
                format!(
                    "GET http://{origin}/one HTTP/1.1\r\nHost: {origin}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("send held request");
        tokio::time::timeout(std::time::Duration::from_secs(10), first_seen_rx)
            .await
            .expect("origin saw the held request")
            .expect("first-seen signal");

        // Second request completes fully first; at cap 1 it evicted the pending
        // first flow when it was recorded.
        let mut second_client = tokio::net::TcpStream::connect(proxy_addr)
            .await
            .expect("connect proxy");
        second_client
            .write_all(
                format!(
                    "GET http://{origin}/two HTTP/1.1\r\nHost: {origin}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("send second request");
        let mut second_response = Vec::new();
        second_client
            .read_to_end(&mut second_response)
            .await
            .expect("read second response");
        let second_response = String::from_utf8_lossy(&second_response).to_lowercase();
        assert!(
            second_response.contains("x-germi-rule: on"),
            "second response: {second_response}"
        );

        release_tx
            .send(())
            .expect("release the held origin response");
        let mut held_response = Vec::new();
        held_client
            .read_to_end(&mut held_response)
            .await
            .expect("read held response");
        let held_response = String::from_utf8_lossy(&held_response).to_lowercase();
        assert!(
            held_response.contains("x-germi-rule: on"),
            "the rule must apply even though the flow was evicted mid-flight: {held_response}"
        );

        c.stop().await;
    }

    /// `Cleared` must be ordered with concurrent captures: replaying the event
    /// stream after a clear racing a burst of inserts must reproduce the store.
    #[test]
    fn cleared_event_stays_ordered_with_concurrent_captures() {
        use std::collections::HashSet;
        let c = controller();
        let mut next_id = 0u32;
        for _ in 0..600 {
            c.clear_flows();
            let mut rx = c.subscribe();
            let producers: Vec<_> = (0..8)
                .map(|_| {
                    let shared = Arc::clone(&c.shared);
                    let base = next_id;
                    next_id += 50;
                    std::thread::spawn(move || {
                        for i in base..base + 50 {
                            shared.record_new(flow(&format!("r{i}")));
                        }
                    })
                })
                .collect();
            while c.shared.store.lock().unwrap().len() < 20 {
                std::hint::spin_loop();
            }
            c.clear_flows();
            for p in producers {
                p.join().expect("producer thread");
            }
            let mut live: HashSet<String> = HashSet::new();
            while let Ok(event) = rx.try_recv() {
                match event {
                    FlowEvent::New { summary } | FlowEvent::Completed { summary } => {
                        live.insert(summary.id);
                    }
                    FlowEvent::Removed { ids } => {
                        for id in ids {
                            live.remove(&id);
                        }
                    }
                    FlowEvent::Cleared => live.clear(),
                    FlowEvent::Resync => {}
                }
            }
            let stored: HashSet<String> =
                c.shared.store.lock().unwrap().ids().into_iter().collect();
            assert_eq!(
                live, stored,
                "replaying the event stream must reproduce the store"
            );
        }
    }

    #[tokio::test]
    async fn check_availability_caches_verdict_and_emits_row() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                let _ = s.flush();
            }
        });

        let c = controller();
        let mut flow = completed_flow("d1");
        flow.request.method = "GET".to_string();
        flow.request.scheme = "http".to_string();
        flow.request.host = addr.to_string();
        flow.request.path = "/doc".to_string();
        flow.request.uri = format!("http://{addr}/doc");
        c.shared.record_imported(flow);
        // Subscribe AFTER the import so the only event we see is the verdict update.
        let mut rx = c.subscribe();

        let checked = c.check_availability(&["d1".to_string()], |_, _| {}).await;
        assert_eq!(checked, 1);

        let availability = c
            .list_flows()
            .into_iter()
            .find(|s| s.id == "d1")
            .and_then(|s| s.availability)
            .expect("verdict cached on the flow");
        assert_eq!(availability.verdict, AvailabilityVerdict::Public);
        assert_eq!(availability.status, Some(200));

        match rx.try_recv() {
            Ok(FlowEvent::Completed { summary }) => {
                assert_eq!(summary.id, "d1");
                assert_eq!(
                    summary
                        .availability
                        .expect("verdict on emitted row")
                        .verdict,
                    AvailabilityVerdict::Public
                );
            }
            other => panic!("expected a Completed availability update, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn check_availability_skips_non_get_methods() {
        let c = controller();
        let mut flow = completed_flow("p1");
        flow.request.method = "POST".to_string();
        c.shared.record_imported(flow);
        // POST is never re-issued (could mutate server state), so nothing is checked.
        let checked = c.check_availability(&["p1".to_string()], |_, _| {}).await;
        assert_eq!(checked, 0);
        assert!(
            c.list_flows()
                .into_iter()
                .find(|s| s.id == "p1")
                .and_then(|s| s.availability)
                .is_none(),
            "a skipped flow keeps a null verdict"
        );
    }

    #[test]
    fn remove_flows_drops_only_selected_and_emits_event() {
        let c = controller();
        let mut rx = c.subscribe();
        for id in ["f1", "f2", "f3"] {
            c.shared.record_new(flow(id));
        }
        for _ in 0..3 {
            assert!(matches!(rx.try_recv(), Ok(FlowEvent::New { .. })));
        }

        c.remove_flows(&["f1".to_string(), "f3".to_string()]);

        {
            let store = c.shared.store.lock().expect("lock store");
            assert!(store.get("f1").is_none());
            assert!(
                store.get("f2").is_some(),
                "an unselected flow survives the prune"
            );
            assert!(store.get("f3").is_none());
            assert_eq!(store.len(), 1);
        }
        match rx.try_recv() {
            Ok(FlowEvent::Removed { ids }) => {
                assert_eq!(ids, vec!["f1".to_string(), "f3".to_string()]);
            }
            other => panic!("expected a Removed event, got {other:?}"),
        }
    }

    #[test]
    fn remove_flows_with_no_present_ids_emits_nothing() {
        let c = controller();
        let mut rx = c.subscribe();
        c.shared.record_new(flow("f1"));
        assert!(matches!(rx.try_recv(), Ok(FlowEvent::New { .. })));

        c.remove_flows(&["ghost".to_string()]);
        assert!(
            rx.try_recv().is_err(),
            "removing ids that were never captured must not emit an event"
        );
        assert_eq!(c.shared.store.lock().expect("lock store").len(), 1);
    }

    #[test]
    fn remove_captured_flows_keeps_imported_and_is_undoable() {
        let c = controller();
        // Two imported reference flows interleaved with two live captures.
        let mut imp1 = flow("imp1");
        imp1.imported = true;
        let mut imp2 = flow("imp2");
        imp2.imported = true;
        c.shared.record_imported(imp1);
        c.shared.record_new(flow("cap1"));
        c.shared.record_imported(imp2);
        c.shared.record_new(flow("cap2"));

        // Subscribe after the inserts so the only event seen is the prune.
        let mut rx = c.subscribe();
        c.remove_captured_flows();

        {
            let store = c.shared.store.lock().expect("lock store");
            assert!(store.get("imp1").is_some(), "imported flows are kept");
            assert!(store.get("imp2").is_some());
            assert!(store.get("cap1").is_none(), "captured flows are pruned");
            assert!(store.get("cap2").is_none());
            assert_eq!(store.ids(), vec!["imp1".to_string(), "imp2".to_string()]);
        }
        match rx.try_recv() {
            Ok(FlowEvent::Removed { ids }) => {
                assert_eq!(ids, vec!["cap1".to_string(), "cap2".to_string()]);
            }
            other => panic!("expected a Removed event for the captured flows, got {other:?}"),
        }

        // Recorded on the timeline: undo restores the pruned captures in place.
        c.undo().expect("undo the capture prune");
        let store = c.shared.store.lock().expect("lock store");
        assert_eq!(
            store.ids(),
            ["imp1", "cap1", "imp2", "cap2"]
                .map(str::to_string)
                .to_vec(),
            "undo restores captured flows to their original capture positions"
        );
    }

    #[test]
    fn remove_captured_flows_with_only_imported_emits_nothing() {
        let c = controller();
        let mut imp = flow("imp1");
        imp.imported = true;
        c.shared.record_imported(imp);
        let mut rx = c.subscribe();
        c.remove_captured_flows();
        assert!(
            rx.try_recv().is_err(),
            "with nothing captured, the prune must not emit an event"
        );
        assert_eq!(c.shared.store.lock().expect("lock store").len(), 1);
    }

    #[test]
    fn lowering_max_flows_evicts_captures_emits_removed_and_keeps_imported() {
        let c = controller();
        let mut imp = flow("imp");
        imp.imported = true;
        c.shared.record_imported(imp);
        c.shared.record_new(completed_flow("a"));
        c.shared.record_new(completed_flow("b"));
        c.shared.record_new(completed_flow("cc"));

        // Subscribe after the inserts so the only event seen is the cap shrink.
        let mut rx = c.subscribe();
        c.set_settings(ProxySettings {
            max_flows: 2,
            ..Default::default()
        });

        {
            let store = c.shared.store.lock().expect("lock store");
            assert!(
                store.get("imp").is_some(),
                "imported reference survives a cap shrink"
            );
            assert_eq!(store.ids(), vec!["imp".to_string(), "cc".to_string()]);
        }
        // The evicted ids are announced so the UI drops exactly those rows instead of
        // silently diverging from the store (issue #80).
        match rx.try_recv() {
            Ok(FlowEvent::Removed { ids }) => {
                assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
            }
            other => panic!("expected a Removed event for the evicted captures, got {other:?}"),
        }
    }

    #[test]
    fn live_capture_is_not_imported_but_opened_flows_are() {
        let c = controller();
        c.shared.record_new(flow("live"));
        assert_eq!(
            c.list_flows()
                .iter()
                .find(|s| s.id == "live")
                .map(|s| s.imported),
            Some(false),
            "a live proxy capture is not marked imported"
        );

        let har = br#"{"log":{"entries":[
          {"request":{"url":"https://a/1"},"response":{"status":200,"headers":[{"name":"x","value":"1"}],"content":{}}}
        ]}}"#;
        c.open_capture(har, "har").expect("open har");
        let summaries = c.list_flows();
        assert!(!summaries.is_empty());
        assert!(
            summaries.iter().all(|s| s.imported),
            "every flow loaded via open_capture is marked imported"
        );
    }

    #[test]
    fn captured_flows_get_increasing_request_numbers() {
        let c = controller();
        for id in ["a", "b", "c"] {
            let mut f = flow(id);
            f.seq = c.shared.next_seq();
            c.shared.record_new(f);
        }
        let seqs: Vec<u64> = c.list_flows().into_iter().map(|s| s.seq).collect();
        assert_eq!(
            seqs,
            vec![1, 2, 3],
            "request numbers increase in capture order"
        );
    }

    #[test]
    fn opening_a_capture_renumbers_from_one() {
        let c = controller();
        // Burn some request numbers on live traffic first.
        for id in ["a", "b", "c"] {
            let mut f = flow(id);
            f.seq = c.shared.next_seq();
            c.shared.record_new(f);
        }
        // Opening a file replaces the traffic AND restarts numbering at 1.
        let bytes = crate::har_export::export_har(&[flow("x"), flow("y")], None);
        let n = c.open_capture(&bytes, "har").expect("open har");
        assert_eq!(n, 2);
        let seqs: Vec<u64> = c.list_flows().into_iter().map(|s| s.seq).collect();
        assert_eq!(
            seqs,
            vec![1, 2],
            "an opened session is numbered 1..N, not continued"
        );
    }

    #[test]
    fn open_capture_har_replaces_current_traffic() {
        let c = controller();
        c.shared.record_new(flow("stale"));
        let har = br#"{"log":{"entries":[
          {"request":{"url":"https://a/1"},"response":{"status":200,"headers":[{"name":"x","value":"1"}],"content":{}}},
          {"request":{"url":"https://a/2"},"response":{"status":200,"headers":[{"name":"x","value":"1"}],"content":{}}}
        ]}}"#;
        let n = c.open_capture(har, "har").expect("open har");
        assert_eq!(n, 2);
        let store = c.shared.store.lock().expect("lock store");
        assert_eq!(
            store.len(),
            2,
            "open replaces — the seeded flow is gone, not appended to"
        );
        assert!(store.get("stale").is_none());
    }

    #[test]
    fn opening_capture_discards_undo_entries_for_previous_traffic() {
        let c = controller();
        c.shared.record_new(flow("stale"));
        c.clear_flows_tracked();
        assert!(c.shared.history.lock().expect("history").can_undo());

        let bytes = crate::har_export::export_har(&[flow("fresh")], None);
        c.open_capture(&bytes, "har").expect("open capture");

        assert!(
            c.undo().is_none(),
            "undo must not restore traffic from the replaced session"
        );
        assert_eq!(c.list_flows().len(), 1);
    }

    #[test]
    fn opening_capture_keeps_mock_undo_history_without_touching_new_traffic() {
        let c = controller();
        seed_one_rule(&c);
        c.with_history(HistoryTag::new("Edit rule", None), |ctrl| {
            ctrl.update_rule("A", rule_with_url("/edited"))
        })
        .expect("edit rule");
        c.shared.record_new(flow("stale"));
        c.clear_flows_tracked();

        let bytes = crate::har_export::export_har(&[flow("fresh")], None);
        c.open_capture(&bytes, "har").expect("open capture");
        let step = c.undo().expect("mock edit remains undoable");
        assert!(step.mock_changed);
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/seq");
        let flows = c.list_flows();
        assert_eq!(
            flows.len(),
            1,
            "mock undo keeps the newly-opened traffic intact"
        );
        assert!(
            flows.iter().all(|flow| flow.id != "stale"),
            "mock undo must not resurrect traffic from the replaced session"
        );
    }

    #[test]
    fn open_capture_of_a_germi_written_har_round_trips_and_replaces() {
        let c = controller();
        c.shared.record_new(flow("stale"));
        let bytes = crate::har_export::export_har(&[flow("a"), flow("b")], None);
        let n = c.open_capture(&bytes, "har").expect("open har");
        assert_eq!(n, 2);
        assert_eq!(c.shared.store.lock().expect("lock store").len(), 2);
    }

    #[test]
    fn undoing_an_inflight_delete_restores_its_late_response() {
        let c = controller();
        c.shared.record_new(flow("pending"));
        c.remove_flows_tracked(&["pending".to_string()]);

        c.shared.record_complete(
            "pending",
            CapturedResponse {
                status: 204,
                version: "HTTP/1.1".into(),
                headers: Vec::new(),
                body: bytes::Bytes::new(),
                timestamp_ms: 1,
            },
            12,
            Some(5),
            None,
        );
        c.undo().expect("delete is undoable");

        let restored = c.get_flow("pending", false, true).expect("flow restored");
        assert_eq!(restored.status, Some(204));
        assert!(
            restored.response.is_some(),
            "late response body is retained"
        );
        assert_eq!(restored.duration_ms, Some(12));
        assert_eq!(c.list_flows()[0].ttfb_ms, Some(5));
    }

    #[test]
    fn redo_snapshot_tracks_a_response_that_arrives_after_delete_was_undone() {
        let c = controller();
        c.shared.record_new(flow("pending"));
        c.remove_flows_tracked(&["pending".to_string()]);
        c.undo().expect("restore pending flow");

        c.shared.record_complete(
            "pending",
            CapturedResponse {
                status: 201,
                version: "HTTP/1.1".into(),
                headers: vec![("x-complete".into(), "yes".into())],
                body: bytes::Bytes::from_static(b"done"),
                timestamp_ms: 2,
            },
            17,
            Some(6),
            Some("late rule".into()),
        );
        c.redo().expect("delete the completed flow again");
        assert!(c.get_flow("pending", false, true).is_none());
        c.undo().expect("restore from the updated delete snapshot");

        let restored = c.get_flow("pending", false, true).expect("flow restored");
        assert_eq!(restored.status, Some(201));
        assert_eq!(restored.duration_ms, Some(17));
        assert_eq!(restored.response.expect("response").body_text, "done");
        assert_eq!(c.list_flows()[0].ttfb_ms, Some(6));
        assert_eq!(c.list_flows()[0].matched_rule.as_deref(), Some("late rule"));
    }

    #[test]
    fn redo_snapshot_tracks_comment_and_availability_changes_after_undo() {
        let c = controller();
        c.shared.record_new(flow("annotated"));
        c.remove_flows_tracked(&["annotated".to_string()]);
        c.undo().expect("restore flow");

        c.set_flow_comment("annotated", Some("keep this note".into()));
        c.shared.set_availability(
            "annotated",
            Availability {
                verdict: AvailabilityVerdict::Protected,
                status: Some(401),
                location: Some("https://example.com/login".into()),
            },
        );
        c.redo().expect("delete the annotated flow again");
        c.undo().expect("restore the updated snapshot");

        let restored = &c.list_flows()[0];
        assert_eq!(restored.comment.as_deref(), Some("keep this note"));
        assert_eq!(
            restored.availability.as_ref().map(|value| value.verdict),
            Some(AvailabilityVerdict::Protected)
        );
        assert_eq!(
            restored
                .availability
                .as_ref()
                .and_then(|value| value.location.as_deref()),
            Some("https://example.com/login")
        );
    }

    #[test]
    fn export_har_embeds_only_the_scenarios_shaping_traffic() {
        let c = controller();
        let mut ar = c.get_autoresponder();
        ar.ensure_general();
        if let Some(general) = ar
            .scenarios
            .iter_mut()
            .find(|s| s.id == GENERAL_SCENARIO_ID)
        {
            general.rules.push(respond_rule("g-1"));
        }
        ar.scenarios
            .push(scenario("active", vec![respond_rule("a-1")]));
        ar.scenarios
            .push(scenario("idle", vec![respond_rule("i-1")]));
        ar.active_scenario_id = Some("active".to_string());
        ar.general_active = true;
        c.set_autoresponder(ar);

        let har: serde_json::Value =
            serde_json::from_slice(&c.export_har(true)).expect("valid JSON");
        let names: Vec<&str> = har["log"]["_germiRules"]["scenarios"]
            .as_array()
            .expect("bundle embedded")
            .iter()
            .map(|s| s["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            vec![GENERAL_SCENARIO_NAME, "active"],
            "the General layer and the active scenario ride along; idle ones don't"
        );

        let plain: serde_json::Value =
            serde_json::from_slice(&c.export_har(false)).expect("valid JSON");
        assert!(plain["log"].get("_germiRules").is_none(), "opt-in only");
    }

    #[test]
    fn export_har_with_nothing_mocking_embeds_no_bundle() {
        let c = controller();
        let mut ar = c.get_autoresponder();
        ar.ensure_general();
        ar.scenarios
            .push(scenario("idle", vec![respond_rule("i-1")]));
        ar.general_active = true;
        c.set_autoresponder(ar);

        let har: serde_json::Value =
            serde_json::from_slice(&c.export_har(true)).expect("valid JSON");
        assert!(
            har["log"].get("_germiRules").is_none(),
            "no active scenario and an empty General layer leave nothing to embed"
        );
    }

    #[test]
    fn har_embedded_rules_import_back_as_re_keyed_deduped_scenarios() {
        let c = controller();
        let mut ar = c.get_autoresponder();
        ar.scenarios.retain(|s| s.id == GENERAL_SCENARIO_ID);
        ar.scenarios
            .push(scenario("orig", vec![respond_rule("r-1")]));
        ar.active_scenario_id = Some("orig".to_string());
        c.set_autoresponder(ar);

        let bundle = har_embedded_rules(&c.export_har(true)).expect("Germi HAR carries the bundle");
        let imported = c.import_rules(&bundle, false).expect("bundle imports");
        assert_eq!(imported, 1);

        let ar = c.get_autoresponder();
        assert_eq!(
            user_names(&ar),
            vec!["orig", "orig (2)"],
            "imported copy lands as a NEW scenario with a deduped name"
        );
        assert_eq!(
            ar.active_scenario_id.as_deref(),
            Some("orig"),
            "importing never switches the active scenario"
        );
    }

    #[test]
    fn open_capture_rejects_unsupported_extension_without_clearing() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        let err = c.open_capture(b"irrelevant", "txt").unwrap_err();
        assert!(err.to_string().contains("Unsupported"));
        assert_eq!(
            c.shared.store.lock().expect("lock store").len(),
            1,
            "a rejected open must leave existing traffic untouched"
        );
    }

    #[test]
    fn cancelled_capture_import_leaves_store_and_history_untouched() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        c.clear_flows_tracked();
        c.undo().expect("restore the tracked flow");
        let history_before = c.shared.history.lock().expect("history").can_undo();
        let bytes = crate::har_export::export_har(&[flow("new-a"), flow("new-b")], None);
        let handle = c.start_capture_import();
        let operation_id = handle.id();

        let error = c
            .run_capture_import(&handle, &bytes, "har", true, |progress| {
                if progress.stage == CaptureImportStage::Processing && progress.completed == 0 {
                    assert!(c.cancel_capture_import(operation_id));
                }
                true
            })
            .err()
            .expect("cancelled import fails");

        assert!(error.to_string().contains(CAPTURE_IMPORT_CANCELLED));
        assert_eq!(
            c.list_flows()
                .iter()
                .map(|flow| flow.id.as_str())
                .collect::<Vec<_>>(),
            vec!["keep"]
        );
        assert_eq!(
            c.shared.history.lock().expect("history").can_undo(),
            history_before,
            "a cancelled replacement must not discard the existing undo timeline"
        );
        assert!(
            !c.cancel_capture_import(operation_id),
            "error cleanup removes the completed operation handle"
        );
    }

    #[test]
    fn newer_capture_import_supersedes_older_parse_before_atomic_commit() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        let old_bytes = crate::har_export::export_har(&[completed_flow("old")], None);
        let new_bytes = crate::har_export::export_har(&[completed_flow("new")], None);
        let old = c.start_capture_import();
        let newest = c.start_capture_import();

        let old_error = c
            .run_capture_import(&old, &old_bytes, "har", true, |_| true)
            .err()
            .expect("superseded import cannot commit");
        assert!(old_error.to_string().contains(CAPTURE_IMPORT_CANCELLED));
        assert_eq!(c.list_flows()[0].id, "keep");

        let result = c
            .run_capture_import(&newest, &new_bytes, "har", true, |_| true)
            .expect("newest import commits");
        assert_eq!(result.summaries.len(), 1);
        assert_eq!(c.list_flows()[0].path, "/new");
    }

    #[test]
    fn stale_reserved_import_cannot_start_after_newer_import_commits() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        let stale_id = c.reserve_capture_import();
        let newest_id = c.reserve_capture_import();

        let stale_error = c
            .claim_capture_import(stale_id)
            .err()
            .expect("a late command cannot reclaim superseded ownership");
        assert!(stale_error.to_string().contains(CAPTURE_IMPORT_CANCELLED));

        let newest = c
            .claim_capture_import(newest_id)
            .expect("newest reservation remains claimable");
        let bytes = crate::har_export::export_har(&[completed_flow("newest")], None);
        c.run_capture_import(&newest, &bytes, "har", true, |_| true)
            .expect("newest reservation commits");
        assert_eq!(c.list_flows()[0].path, "/newest");
    }

    #[test]
    fn running_parser_is_cancelled_when_a_newer_reservation_is_claimed() {
        let c = Arc::new(controller());
        c.shared.record_new(flow("keep"));
        let old = c.start_capture_import();
        let body = "x".repeat(2 * 1024 * 1024);
        let old_bytes = format!(
            r#"{{"log":{{"entries":[{{"request":{{"url":"https://old/"}},"response":{{"content":{{"text":"{body}"}}}}}}]}}}}"#
        )
        .into_bytes();
        let (parsing_tx, parsing_rx) = std::sync::mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
        let worker_controller = c.clone();
        let worker = std::thread::spawn(move || {
            let mut paused = false;
            worker_controller.run_capture_import(&old, &old_bytes, "har", true, |progress| {
                if !paused
                    && progress.stage == CaptureImportStage::Parsing
                    && progress.completed > 0
                {
                    paused = true;
                    parsing_tx.send(()).expect("signal active parser");
                    resume_rx.recv().expect("resume active parser");
                }
                true
            })
        });

        parsing_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("old parser reached its decode loop");
        let newest_id = c.reserve_capture_import();
        let newest = c
            .claim_capture_import(newest_id)
            .expect("newer UI reservation claims global ownership");
        resume_tx.send(()).expect("release old parser");
        let old_error = worker
            .join()
            .expect("old parser thread")
            .err()
            .expect("superseded running parser fails");
        assert!(old_error.to_string().contains(CAPTURE_IMPORT_CANCELLED));
        assert_eq!(c.list_flows()[0].id, "keep");

        let bytes = crate::har_export::export_har(&[completed_flow("newest")], None);
        c.run_capture_import(&newest, &bytes, "har", true, |_| true)
            .expect("newest import commits after cancelling active parse");
        assert_eq!(c.list_flows()[0].path, "/newest");
    }

    #[test]
    fn concurrent_reservations_cannot_install_a_lower_token_last() {
        let c = Arc::new(controller());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let reserve = |controller: Arc<ProxyController>, barrier: Arc<std::sync::Barrier>| {
            std::thread::spawn(move || {
                barrier.wait();
                controller.reserve_capture_import()
            })
        };
        let first = reserve(c.clone(), barrier.clone());
        let second = reserve(c.clone(), barrier.clone());
        barrier.wait();
        let mut ids = [
            first.join().expect("main-window reservation"),
            second.join().expect("compare-window reservation"),
        ];
        ids.sort_unstable();

        let imports = c.capture_imports.lock().expect("capture operations");
        assert_eq!(imports.last_id, ids[1]);
        assert_eq!(
            imports.pending.as_ref().map(CaptureImportHandle::id),
            Some(ids[1])
        );
        drop(imports);
        assert!(c.claim_capture_import(ids[0]).is_err());
        assert!(c.claim_capture_import(ids[1]).is_ok());
    }

    #[test]
    fn cancelling_a_pending_picker_does_not_cancel_an_active_import() {
        let c = controller();
        let active = c.start_capture_import();
        let picker = c.reserve_capture_import();
        assert!(c.cancel_capture_import(picker));

        let bytes = crate::har_export::export_har(&[completed_flow("active")], None);
        c.run_capture_import(&active, &bytes, "har", true, |_| true)
            .expect("picker cancellation leaves the active parser eligible");
        assert_eq!(c.list_flows()[0].path, "/active");
    }

    #[test]
    fn failed_import_cleans_up_before_a_sequential_success() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        let failed = c.start_capture_import();
        assert!(c
            .run_capture_import(&failed, b"not json", "har", true, |_| true)
            .is_err());
        assert!(!c.cancel_capture_import(failed.id()));
        assert_eq!(c.list_flows()[0].id, "keep");

        let next = c.start_capture_import();
        let bytes = crate::har_export::export_har(&[completed_flow("after-error")], None);
        let mut saw_non_cancelable_commit = false;
        c.run_capture_import(&next, &bytes, "har", true, |progress| {
            if progress.stage == CaptureImportStage::Finalizing {
                saw_non_cancelable_commit |= !progress.cancelable;
            }
            true
        })
        .expect("a later import is not blocked by failure cleanup");
        assert!(saw_non_cancelable_commit);
        assert_eq!(c.list_flows()[0].path, "/after-error");
    }

    #[test]
    fn append_capture_adds_to_existing_traffic_and_returns_the_new_summaries() {
        let c = controller();
        c.shared.record_new(flow("live"));
        let har = br#"{"log":{"entries":[
          {"request":{"url":"https://a/1"},"response":{"status":200,"headers":[{"name":"x","value":"1"}],"content":{}}},
          {"request":{"url":"https://a/2"},"response":{"status":201,"headers":[{"name":"x","value":"1"}],"content":{}}}
        ]}}"#;
        let appended = c.append_capture(har, "har").expect("append har");
        assert_eq!(appended.len(), 2);
        assert!(
            appended.iter().all(|s| s.imported),
            "appended flows carry the imported marker"
        );
        assert_eq!(
            appended.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            vec!["/1", "/2"],
            "summaries come back in file order"
        );
        let store = c.shared.store.lock().expect("lock store");
        assert_eq!(
            store.len(),
            3,
            "append adds to the traffic instead of replacing it"
        );
        assert!(
            store.get("live").is_some(),
            "existing traffic survives the append"
        );
    }

    #[test]
    fn append_capture_continues_request_numbering() {
        let c = controller();
        let mut live = flow("live");
        live.seq = c.shared.next_seq();
        c.shared.record_new(live);
        let bytes = crate::har_export::export_har(&[flow("x")], None);
        let appended = c.append_capture(&bytes, "har").expect("append har");
        assert_eq!(
            appended[0].seq, 2,
            "an appended reference session continues numbering, it never renumbers from 1"
        );
    }

    #[test]
    fn append_capture_rejects_unsupported_extension_without_touching_traffic() {
        let c = controller();
        c.shared.record_new(flow("keep"));
        assert!(c.append_capture(b"irrelevant", "txt").is_err());
        assert_eq!(c.shared.store.lock().expect("lock store").len(), 1);
    }

    fn flow_with_bodies(
        id: &str,
        req_body: &[u8],
        resp_headers: &[(&str, &str)],
        resp_body: &[u8],
    ) -> crate::flow::Flow {
        let mut f = flow(id);
        f.request.body = req_body.to_vec().into();
        f.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: resp_headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: resp_body.to_vec().into(),
            timestamp_ms: 1,
        });
        f
    }

    fn gzipped(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(bytes).expect("gzip write");
        enc.finish().expect("gzip finish")
    }

    #[test]
    fn compare_bodies_matches_decoded_content_across_encodings() {
        let c = controller();
        c.shared
            .record_new(flow_with_bodies("plain", b"ask", &[], b"same payload"));
        c.shared.record_new(flow_with_bodies(
            "gz",
            b"ask",
            &[("content-encoding", "gzip")],
            &gzipped(b"same payload"),
        ));
        let cmp = c.compare_bodies("plain", "gz").expect("both flows exist");
        assert!(cmp.request_equal);
        assert_eq!(
            cmp.response_equal,
            Some(true),
            "a gzip body and an identity body with the same content compare equal"
        );
    }

    #[test]
    fn compare_bodies_detects_differing_sides_independently() {
        let c = controller();
        c.shared
            .record_new(flow_with_bodies("a", b"same-req", &[], b"payload-a"));
        c.shared
            .record_new(flow_with_bodies("b", b"same-req", &[], b"payload-b"));
        let cmp = c.compare_bodies("a", "b").expect("both flows exist");
        assert!(cmp.request_equal, "identical request bodies compare equal");
        assert_eq!(
            cmp.response_equal,
            Some(false),
            "differing response bodies are reported"
        );
    }

    #[test]
    fn compare_bodies_is_none_per_side_without_a_response_and_overall_for_unknown_ids() {
        let c = controller();
        c.shared.record_new(flow("pending"));
        c.shared.record_new(completed_flow("done"));
        let cmp = c
            .compare_bodies("pending", "done")
            .expect("both flows exist");
        assert_eq!(
            cmp.response_equal, None,
            "a missing response on either side yields no response verdict"
        );
        assert!(c.compare_bodies("pending", "ghost").is_none());
        assert!(c.compare_bodies("ghost", "done").is_none());
    }

    #[test]
    fn bulk_mock_builds_rules_for_large_selections_in_input_order() {
        let c = controller();
        let ids: Vec<String> = (0..400).map(|i| format!("flow-{i}")).collect();
        for id in &ids {
            c.shared.record_new(completed_flow(id));
        }

        let result = c.mock_flows(&ids, Some("bulk"));

        assert_eq!(result.new_rule_ids.len(), ids.len());
        let autoresponder = c.get_autoresponder();
        let scenario = autoresponder
            .scenarios
            .iter()
            .find(|scenario| scenario.id == "bulk")
            .expect("bulk scenario");
        assert_eq!(scenario.rules.len(), ids.len());
        assert_eq!(scenario.rules[0].matcher.url, "https://example.com/flow-0");
        assert_eq!(
            scenario.rules.last().expect("last rule").matcher.url,
            "https://example.com/flow-399"
        );
        assert!(matches!(
            &scenario.rules[0].action,
            Action::Respond { body, .. } if body == "response-flow-0"
        ));
    }

    #[test]
    fn autoresponder_summary_omits_rule_bodies_and_headers() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: "summary".to_string(),
                name: "Summary".to_string(),
                rules: vec![Rule {
                    id: "large".to_string(),
                    enabled: true,
                    fire_limit: None,
                    repeat: false,
                    matcher: Matcher {
                        method: Some("GET".to_string()),
                        url: "https://example.com/large".to_string(),
                        url_match: MatchKind::Exact,
                    },
                    action: Action::Respond {
                        status: 200,
                        headers: vec![("x-secret".to_string(), "header-secret".to_string())],
                        body: "body-secret".to_string(),
                        body_base64: None,
                        content_type: Some("text/plain".to_string()),
                        content_encoding: None,
                    },
                }],
            }],
            active_scenario_id: Some("summary".to_string()),
            general_active: true,
        });

        let json = serde_json::to_string(&c.autoresponder_summary()).expect("serialize summary");

        assert!(!json.contains("body-secret"));
        assert!(!json.contains("header-secret"));
        assert!(json.contains("\"status\":200"));
        assert_eq!(
            c.get_rule("large")
                .and_then(|rule| match rule.action {
                    Action::Respond { body, .. } => Some(body),
                    _ => None,
                })
                .as_deref(),
            Some("body-secret")
        );
    }

    #[test]
    fn granular_rule_reorder_changes_only_order() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario(
                "scenario",
                vec![
                    respond_rule("one"),
                    respond_rule("two"),
                    respond_rule("three"),
                ],
            )],
            active_scenario_id: Some("scenario".to_string()),
            general_active: true,
        });

        let (previous, next) = c
            .reorder_rule("scenario", "three", "one")
            .expect("reorder rule");

        assert_eq!(previous, None);
        assert_eq!(next.as_deref(), Some("one"));
        let order = c
            .autoresponder_summary()
            .scenarios
            .into_iter()
            .next()
            .expect("scenario")
            .rules
            .into_iter()
            .map(|rule| rule.id)
            .collect::<Vec<_>>();
        assert_eq!(order, vec!["three", "one", "two"]);
    }

    #[test]
    fn set_autoresponder_sticky_reset_fork() {
        let controller = controller();

        let ar_a = AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("seq-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        };
        controller.set_autoresponder(ar_a.clone());

        fire_active_once(&controller);
        assert_eq!(
            controller.rule_hits().get("seq-rule").copied(),
            Some(1),
            "firing the active rule must advance its cursor"
        );

        controller.set_autoresponder(ar_a.clone());
        assert_eq!(
            controller.rule_hits().get("seq-rule").copied(),
            Some(1),
            "re-applying the same active scenario must preserve in-progress hits"
        );

        let ar_b = AutoResponder {
            scenarios: vec![
                scenario("A", vec![respond_rule("seq-rule")]),
                scenario("B", vec![respond_rule("other-rule")]),
            ],
            active_scenario_id: Some("B".to_string()),
            general_active: true,
        };
        controller.set_autoresponder(ar_b);
        assert!(
            controller.rule_hits().is_empty(),
            "switching the active scenario must fully reset every cursor"
        );
    }

    #[test]
    fn set_autoresponder_same_active_drops_deleted_rule() {
        let controller = controller();

        let with_rule = AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("seq-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        };
        controller.set_autoresponder(with_rule);
        fire_active_once(&controller);
        assert_eq!(
            controller.rule_hits().get("seq-rule").copied(),
            Some(1),
            "the rule fired before deletion"
        );

        let rule_removed = AutoResponder {
            scenarios: vec![scenario("A", vec![])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        };
        controller.set_autoresponder(rule_removed);
        assert!(
            !controller.rule_hits().contains_key("seq-rule"),
            "reset_missing must drop the counter for a deleted rule even when the active scenario is unchanged"
        );
    }

    #[test]
    fn import_rules_merges_and_preserves_active() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("a-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("B", vec![respond_rule("b-rule")])],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, false).expect("import");
        assert_eq!(count, 1);

        let ar = dst.get_autoresponder();
        assert_eq!(
            user_names(&ar),
            vec!["A", "B"],
            "merge appends the imported scenario"
        );
        assert!(
            ar.general().is_some(),
            "the built-in General layer stays present"
        );
        assert_eq!(
            ar.active_scenario_id.as_deref(),
            Some("A"),
            "merge must not steal the active selection"
        );
        let imported = ar
            .scenarios
            .iter()
            .find(|s| s.name == "B")
            .expect("imported B");
        assert_ne!(imported.id, "B", "imported scenario must be re-keyed");
    }

    #[test]
    fn imported_general_can_remain_an_ordinary_scenario() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("existing-general")]),
                scenario("A", vec![]),
            ],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });
        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![general_scenario(vec![respond_rule("imported-general")])],
            active_scenario_id: None,
            general_active: true,
        });

        dst.import_rules_with_general(
            &src.export_rules(None),
            false,
            GeneralRulesImportMode::AsScenario,
        )
        .expect("import General as an ordinary scenario");

        let ar = dst.get_autoresponder();
        assert_eq!(
            ar.general().expect("General").rules[0].id,
            "existing-general"
        );
        assert_eq!(user_names(&ar), vec!["A", "General rules (2)"]);
        let ordinary = ar.scenarios.last().expect("ordinary imported scenario");
        assert_ne!(ordinary.id, GENERAL_SCENARIO_ID);
        assert_ne!(ordinary.rules[0].id, "imported-general");
        assert_eq!(ar.active_scenario_id.as_deref(), Some("A"));
    }

    #[test]
    fn imported_general_rules_merge_into_the_built_in_layer() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("existing-general")]),
                scenario("A", vec![]),
            ],
            active_scenario_id: Some("A".to_string()),
            general_active: false,
        });
        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("imported-general")]),
                scenario("B", vec![]),
            ],
            active_scenario_id: None,
            general_active: true,
        });

        let count = dst
            .import_rules_with_general(
                &src.export_rules(None),
                false,
                GeneralRulesImportMode::Merge,
            )
            .expect("merge General");

        assert_eq!(count, 2);
        let ar = dst.get_autoresponder();
        let general = ar.general().expect("General");
        assert_eq!(general.rules.len(), 2);
        assert_eq!(general.rules[0].id, "existing-general");
        assert_ne!(
            general.rules[1].id, "imported-general",
            "import is re-keyed"
        );
        assert_eq!(
            general.rules[1].action,
            respond_rule("imported-general").action
        );
        assert_eq!(user_names(&ar), vec!["A", "B"]);
        assert_eq!(ar.active_scenario_id.as_deref(), Some("A"));
        assert!(
            !ar.general_active,
            "import does not silently enable General"
        );
    }

    #[test]
    fn imported_general_rules_replace_only_the_built_in_layer() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("old-one"), respond_rule("old-two")]),
                scenario("A", vec![]),
            ],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });
        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("new-general")]),
                scenario("B", vec![]),
            ],
            active_scenario_id: None,
            general_active: true,
        });

        dst.import_rules_with_general(
            &src.export_rules(None),
            false,
            GeneralRulesImportMode::Replace,
        )
        .expect("replace General");

        let ar = dst.get_autoresponder();
        let general = ar.general().expect("General");
        assert_eq!(general.rules.len(), 1);
        assert_ne!(general.rules[0].id, "new-general", "import is re-keyed");
        assert_eq!(general.rules[0].action, respond_rule("new-general").action);
        assert_eq!(user_names(&ar), vec!["A", "B"]);
        assert_eq!(ar.active_scenario_id.as_deref(), Some("A"));
    }

    #[test]
    fn regular_scenario_replace_and_general_merge_are_independent() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("existing-general")]),
                scenario("A", vec![]),
            ],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });
        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                general_scenario(vec![respond_rule("imported-general")]),
                scenario("B", vec![]),
            ],
            active_scenario_id: None,
            general_active: true,
        });

        dst.import_rules_with_general(&src.export_rules(None), true, GeneralRulesImportMode::Merge)
            .expect("replace regular scenarios while merging General");

        let ar = dst.get_autoresponder();
        assert_eq!(user_names(&ar), vec!["B"]);
        assert_eq!(ar.general().expect("General").rules.len(), 2);
        assert_eq!(ar.active_scenario_id, None);
    }

    #[test]
    fn import_rules_dedupes_names() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: "x".to_string(),
                name: "My mocks".to_string(),
                rules: vec![],
            }],
            active_scenario_id: None,
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: "y".to_string(),
                name: "My mocks".to_string(),
                rules: vec![],
            }],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        assert_eq!(
            user_names(&dst.get_autoresponder()),
            vec!["My mocks".to_string(), "My mocks (2)".to_string()]
        );
    }

    #[test]
    fn export_single_scenario_filters() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![
                scenario("A", vec![respond_rule("a-rule")]),
                scenario("B", vec![respond_rule("b-rule")]),
            ],
            active_scenario_id: None,
            general_active: true,
        });

        let only_a = rules_export::parse_rules(&c.export_rules(Some("A"))).expect("parse A");
        assert_eq!(
            only_a.len(),
            1,
            "exporting one id yields exactly that scenario"
        );
        assert_eq!(only_a[0].name, "A");

        let missing =
            rules_export::parse_rules(&c.export_rules(Some("missing"))).expect("parse missing");
        assert!(
            missing.is_empty(),
            "exporting an unknown id yields an empty bundle"
        );
    }

    #[test]
    fn import_rekey_avoids_cursor_aliasing() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("seq-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        fire_active_once(&c);
        assert_eq!(
            c.rule_hits().get("seq-rule").copied(),
            Some(1),
            "the original rule fired once"
        );

        // Import a copy of A back into the same controller; the clone's rule must
        // get a fresh id so it does NOT inherit the original's (consumed) hit.
        let bytes = c.export_rules(Some("A"));
        c.import_rules(&bytes, false).expect("import");

        let ar = c.get_autoresponder();
        let clone = ar
            .scenarios
            .iter()
            .rev()
            .find(|s| s.name == "A (2)")
            .expect("imported clone");
        let clone_rule_id = &clone.rules[0].id;
        assert_ne!(
            clone_rule_id, "seq-rule",
            "the imported rule must be re-keyed away from the original id"
        );
        assert_eq!(
            c.rule_hits()
                .get(clone_rule_id.as_str())
                .copied()
                .unwrap_or(0),
            0,
            "the re-keyed clone starts with an independent (zero) hit count"
        );
    }

    #[test]
    fn import_rules_replace_clears_existing() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![
                scenario("A", vec![respond_rule("a-rule")]),
                scenario("B", vec![respond_rule("b-rule")]),
            ],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("C", vec![respond_rule("c-rule")])],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, true).expect("replace import");
        assert_eq!(count, 1);

        let ar = dst.get_autoresponder();
        assert_eq!(
            user_names(&ar),
            vec!["C"],
            "replace wipes the existing user scenarios"
        );
        assert!(
            ar.general().is_some(),
            "the built-in General layer survives a replace"
        );
        let c = ar
            .scenarios
            .iter()
            .find(|s| s.id != GENERAL_SCENARIO_ID)
            .expect("replaced-in scenario");
        assert_ne!(c.id, "C", "the replaced-in scenario is re-keyed");
        assert_ne!(c.rules[0].id, "c-rule", "its rule is re-keyed too");
        assert_eq!(
            ar.active_scenario_id, None,
            "replace resets the active pointer to Off"
        );
    }

    #[test]
    fn import_rules_replace_on_empty_config() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![],
            active_scenario_id: None,
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("Only", vec![respond_rule("only-rule")])],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, true).expect("replace into empty");
        assert_eq!(count, 1);
        let ar = dst.get_autoresponder();
        assert_eq!(
            user_names(&ar),
            vec!["Only"],
            "replace into an empty config yields exactly the import"
        );
        assert!(
            ar.general().is_some(),
            "General is seeded even into an empty config"
        );
        assert_eq!(
            ar.active_scenario_id, None,
            "still Off after replace into empty"
        );
    }

    #[test]
    fn import_one_file_with_duplicate_names_dedupes_within_file() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![],
            active_scenario_id: None,
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                Scenario {
                    id: "a".into(),
                    name: "Set".into(),
                    rules: vec![],
                },
                Scenario {
                    id: "b".into(),
                    name: "Set".into(),
                    rules: vec![],
                },
                Scenario {
                    id: "c".into(),
                    name: "Set".into(),
                    rules: vec![],
                },
            ],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        assert_eq!(
            user_names(&dst.get_autoresponder()),
            vec![
                "Set".to_string(),
                "Set (2)".to_string(),
                "Set (3)".to_string()
            ],
            "duplicate names inside a single imported file are de-duped in order"
        );
    }

    #[test]
    fn merge_dedupes_against_existing_and_within_file() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: "x".into(),
                name: "Set".into(),
                rules: vec![],
            }],
            active_scenario_id: None,
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                Scenario {
                    id: "a".into(),
                    name: "Set".into(),
                    rules: vec![],
                },
                Scenario {
                    id: "b".into(),
                    name: "Set".into(),
                    rules: vec![],
                },
            ],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        assert_eq!(
            user_names(&dst.get_autoresponder()),
            vec![
                "Set".to_string(),
                "Set (2)".to_string(),
                "Set (3)".to_string()
            ],
            "merge de-dupes the imported names against the existing one AND against each other"
        );
    }

    #[test]
    fn import_twice_same_ms_keeps_clones_independent() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("seq-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        let bytes = c.export_rules(Some("A"));
        c.import_rules(&bytes, false).expect("first import");
        c.import_rules(&bytes, false).expect("second import");

        let ar = c.get_autoresponder();
        let rule_ids: Vec<String> = ar
            .scenarios
            .iter()
            .flat_map(|s| s.rules.iter().map(|r| r.id.clone()))
            .collect();
        let unique: std::collections::HashSet<&String> = rule_ids.iter().collect();
        assert_eq!(
            unique.len(),
            rule_ids.len(),
            "two imports of the same file must not produce colliding rule ids (cursor aliasing)"
        );
    }

    #[test]
    fn import_rules_replace_resets_active_off() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("a-rule")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("B", vec![respond_rule("b-rule")])],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, true).expect("replace import");
        assert_eq!(
            dst.get_autoresponder().active_scenario_id,
            None,
            "a non-empty replace must never auto-activate a scenario"
        );
    }

    // ---- undo / redo history ----

    fn seed_one_rule(c: &ProxyController) {
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![respond_rule("r1")])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });
    }

    fn rule_with_url(url: &str) -> Rule {
        let mut rule = respond_rule("r1");
        rule.matcher.url = url.to_string();
        rule
    }

    fn timeline(c: &ProxyController) -> Vec<u64> {
        c.shared.history.lock().expect("history").timeline_ids()
    }

    #[test]
    fn delete_rules_removes_many_skips_missing_and_undoes_as_one_step() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario(
                "A",
                vec![respond_rule("r1"), respond_rule("r2"), respond_rule("r3")],
            )],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        let removed = c
            .with_history(HistoryTag::new("Delete 2 rules", None), |ctrl| {
                // "gone" isn't a rule id — it must be skipped, not abort the batch.
                ctrl.delete_rules(
                    "A",
                    &["r1".to_string(), "gone".to_string(), "r3".to_string()],
                )
            })
            .expect("delete_rules");
        assert_eq!(
            removed, 2,
            "only the two present ids are counted as removed"
        );

        let remaining: Vec<String> = c
            .get_autoresponder()
            .scenarios
            .iter()
            .find(|s| s.id == "A")
            .expect("scenario A")
            .rules
            .iter()
            .map(|rule| rule.id.clone())
            .collect();
        assert_eq!(
            remaining,
            vec!["r2".to_string()],
            "r1 and r3 are gone, r2 stays"
        );
        assert_eq!(
            timeline(&c).len(),
            1,
            "a batch delete is a single undo entry"
        );

        c.undo().expect("undo");
        let restored: Vec<String> = c
            .get_autoresponder()
            .scenarios
            .iter()
            .find(|s| s.id == "A")
            .expect("scenario A")
            .rules
            .iter()
            .map(|rule| rule.id.clone())
            .collect();
        assert_eq!(
            restored,
            vec!["r1".to_string(), "r2".to_string(), "r3".to_string()],
            "one undo restores every deleted rule in order"
        );
    }

    #[test]
    fn delete_rules_all_missing_records_no_history() {
        let c = controller();
        seed_one_rule(&c);
        let removed = c
            .with_history(HistoryTag::new("Delete rules", None), |ctrl| {
                ctrl.delete_rules("A", &["nope".to_string()])
            })
            .expect("delete_rules");
        assert_eq!(removed, 0, "nothing present to remove");
        assert!(
            timeline(&c).is_empty(),
            "a batch that removes nothing records no undo entry"
        );
    }

    #[test]
    fn mock_edit_undo_redo_round_trips() {
        let c = controller();
        seed_one_rule(&c);

        c.with_history(HistoryTag::new("Edit rule", None), |ctrl| {
            ctrl.update_rule("A", rule_with_url("/edited"))
        })
        .expect("update");
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/edited");

        let step = c.undo().expect("undo");
        assert!(
            step.mock_changed,
            "a mock undo must signal the caller to re-persist"
        );
        {
            let history = c.shared.history.lock().expect("history");
            assert!(!history.can_undo() && history.can_redo());
        }
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/seq",
            "undo restores the prior url"
        );

        let step = c.redo().expect("redo");
        assert!(step.mock_changed);
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/edited",
            "redo re-applies the edit"
        );
    }

    #[test]
    fn coalesced_edits_undo_as_a_single_step() {
        let c = controller();
        seed_one_rule(&c);
        let key = Some("edit:r1:url".to_string());
        for url in ["/a", "/ab", "/abc"] {
            c.with_history(HistoryTag::new("Edit rule url", key.clone()), |ctrl| {
                ctrl.update_rule("A", rule_with_url(url))
            })
            .expect("update");
        }
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/abc");
        assert_eq!(
            timeline(&c).len(),
            1,
            "three same-key edits collapse to one undo entry"
        );

        c.undo().expect("undo");
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/seq",
            "one undo reverts the whole coalesced run"
        );
    }

    #[test]
    fn failed_or_noop_mutation_records_no_history() {
        let c = controller();
        seed_one_rule(&c);

        // Identical update → before == after → nothing recorded.
        c.with_history(HistoryTag::new("noop", None), |ctrl| {
            ctrl.update_rule("A", respond_rule("r1"))
        })
        .expect("update");
        assert!(
            timeline(&c).is_empty(),
            "an identical update records nothing"
        );

        // Failed update (missing scenario) → nothing recorded.
        let failed = c.with_history(HistoryTag::new("fail", None), |ctrl| {
            ctrl.update_rule("missing", respond_rule("r1"))
        });
        assert!(failed.is_err());
        assert!(timeline(&c).is_empty(), "a failed mutation records nothing");
        assert!(c.undo().is_none(), "nothing to undo");
    }

    #[test]
    fn failure_after_a_live_mutation_restores_the_before_snapshot() {
        let c = controller();
        seed_one_rule(&c);

        let failed = c.with_history(HistoryTag::new("persisted edit", None), |ctrl| {
            ctrl.update_rule("A", rule_with_url("/memory-only"))
                .expect("live mutation succeeds");
            Err::<(), _>("database write failed")
        });

        assert_eq!(failed, Err("database write failed"));
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/seq",
            "a rejected command must not leave a memory-only autoresponder change"
        );
        assert!(timeline(&c).is_empty());
    }

    #[test]
    fn failure_after_rule_deletion_restores_its_runtime_cursor() {
        let c = controller();
        seed_one_rule(&c);
        fire_active_once(&c);
        assert_eq!(c.rule_hits().get("r1"), Some(&1));

        let failed = c.with_history(HistoryTag::new("Delete rule", None), |ctrl| {
            ctrl.delete_rule("A", "r1").expect("live delete succeeds");
            Err::<(), _>("database write failed")
        });

        assert_eq!(failed, Err("database write failed"));
        assert!(c.get_rule("r1").is_some());
        assert_eq!(
            c.rule_hits().get("r1"),
            Some(&1),
            "a rejected delete must not reset the restored rule's fire limit"
        );
    }

    #[test]
    fn failed_undo_or_redo_callback_restores_state_and_history_cursor() {
        let c = controller();
        seed_one_rule(&c);
        c.with_history(HistoryTag::new("Edit rule", None), |ctrl| {
            ctrl.update_rule("A", rule_with_url("/edited"))
        })
        .expect("edit");

        let undo_error = c.undo_and_then(|ctrl, _| {
            assert_eq!(ctrl.get_rule("r1").expect("rule").matcher.url, "/seq");
            Err::<(), _>("database write failed")
        });
        assert!(matches!(undo_error, Err("database write failed")));
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/edited",
            "failed undo persistence restores the edited live state"
        );
        {
            let history = c.shared.history.lock().expect("history");
            assert!(history.can_undo() && !history.can_redo());
        }

        c.undo().expect("undo remains available");
        let redo_error = c.redo_and_then(|ctrl, _| {
            assert_eq!(ctrl.get_rule("r1").expect("rule").matcher.url, "/edited");
            Err::<(), _>("database write failed")
        });
        assert!(matches!(redo_error, Err("database write failed")));
        assert_eq!(
            c.get_rule("r1").expect("rule").matcher.url,
            "/seq",
            "failed redo persistence restores the undone live state"
        );
        {
            let history = c.shared.history.lock().expect("history");
            assert!(!history.can_undo() && history.can_redo());
        }
        c.redo().expect("redo remains available");
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/edited");
    }

    #[test]
    fn failed_undo_or_redo_callback_restores_runtime_rule_cursors() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![
                scenario("A", vec![respond_rule("a-rule")]),
                scenario("B", vec![respond_rule("b-rule")]),
            ],
            active_scenario_id: Some("A".into()),
            general_active: true,
        });
        c.with_history(HistoryTag::new("Activate B", None), |ctrl| {
            ctrl.set_active_scenario(Some("B"))
        })
        .expect("activate B");
        fire_active_once(&c);
        assert_eq!(c.rule_hits().get("b-rule"), Some(&1));

        let undo_error = c.undo_and_then(|_, _| Err::<(), _>("database write failed"));
        assert!(matches!(undo_error, Err("database write failed")));
        assert_eq!(
            c.get_autoresponder().active_scenario_id.as_deref(),
            Some("B")
        );
        assert_eq!(c.rule_hits().get("b-rule"), Some(&1));

        c.undo().expect("undo remains available");
        fire_active_once(&c);
        assert_eq!(c.rule_hits().get("a-rule"), Some(&1));
        let redo_error = c.redo_and_then(|_, _| Err::<(), _>("database write failed"));
        assert!(matches!(redo_error, Err("database write failed")));
        assert_eq!(
            c.get_autoresponder().active_scenario_id.as_deref(),
            Some("A")
        );
        assert_eq!(c.rule_hits().get("a-rule"), Some(&1));
    }

    #[test]
    fn concurrent_history_mutations_are_serialized_as_complete_transactions() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let c = Arc::new(controller());
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![])],
            active_scenario_id: Some("S".into()),
            general_active: true,
        });

        let (a_entered_tx, a_entered_rx) = mpsc::channel();
        let (release_a_tx, release_a_rx) = mpsc::channel();
        let a_controller = Arc::clone(&c);
        let a = std::thread::spawn(move || {
            a_controller
                .with_history(HistoryTag::new("A", None), |ctrl| {
                    a_entered_tx.send(()).expect("signal A");
                    release_a_rx.recv().expect("release A");
                    let mut ar = ctrl.get_autoresponder();
                    ar.scenarios[0].name = "A".into();
                    ctrl.set_autoresponder(ar);
                    Ok::<_, ()>(())
                })
                .expect("A mutation");
        });
        a_entered_rx.recv().expect("A entered transaction");

        let (b_entered_tx, b_entered_rx) = mpsc::channel();
        let b_controller = Arc::clone(&c);
        let b = std::thread::spawn(move || {
            b_controller
                .with_history(HistoryTag::new("B", None), |ctrl| {
                    b_entered_tx.send(()).expect("signal B");
                    let mut ar = ctrl.get_autoresponder();
                    ar.scenarios[0].name = "B".into();
                    ctrl.set_autoresponder(ar);
                    Ok::<_, ()>(())
                })
                .expect("B mutation");
        });

        assert!(
            b_entered_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "B must not enter while A still owns its before/mutate/after transaction"
        );
        release_a_tx.send(()).expect("release A");
        a.join().expect("join A");
        b_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("B enters after A");
        b.join().expect("join B");

        assert_eq!(c.get_autoresponder().scenarios[0].name, "B");
        c.undo().expect("undo B");
        assert_eq!(c.get_autoresponder().scenarios[0].name, "A");
        c.undo().expect("undo A");
        assert_eq!(c.get_autoresponder().scenarios[0].name, "S");
    }

    #[test]
    fn activate_scenario_undo_restores_prior_active() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("A", vec![]), scenario("B", vec![])],
            active_scenario_id: Some("A".to_string()),
            general_active: true,
        });

        c.with_history(HistoryTag::new("Activate B", None), |ctrl| {
            ctrl.set_active_scenario(Some("B"))
        })
        .expect("activate");
        assert_eq!(
            c.get_autoresponder().active_scenario_id.as_deref(),
            Some("B")
        );

        c.undo().expect("undo");
        assert_eq!(
            c.get_autoresponder().active_scenario_id.as_deref(),
            Some("A"),
            "undo restores the prior active scenario"
        );
    }

    #[test]
    fn remove_flows_tracked_undo_restores_bodies_and_capture_order() {
        let c = controller();
        for id in ["a", "b", "c", "d"] {
            c.shared.record_imported(completed_flow(id));
        }
        c.remove_flows_tracked(&["b".to_string(), "d".to_string()]);
        assert_eq!(
            c.shared.store.lock().expect("store").ids(),
            vec!["a".to_string(), "c".to_string()]
        );

        let step = c.undo().expect("undo restores flows");
        assert!(
            !step.mock_changed,
            "a traffic undo never touches the autoresponder"
        );
        {
            let store = c.shared.store.lock().expect("store");
            assert_eq!(
                store.ids(),
                ["a", "b", "c", "d"].map(str::to_string).to_vec(),
                "undo restores the exact capture order"
            );
            let body = &store
                .get("b")
                .expect("flow b is back")
                .response
                .as_ref()
                .expect("resp")
                .body;
            assert_eq!(
                String::from_utf8_lossy(body),
                "response-b",
                "the full response body is restored, not just the summary"
            );
        }

        c.redo().expect("redo");
        assert_eq!(
            c.shared.store.lock().expect("store").ids(),
            vec!["a".to_string(), "c".to_string()],
            "redo re-removes the same flows"
        );
    }

    #[test]
    fn clear_flows_tracked_undo_restores_everything() {
        let c = controller();
        for id in ["a", "b", "c"] {
            c.shared.record_imported(completed_flow(id));
        }
        c.clear_flows_tracked();
        assert!(c.shared.store.lock().expect("store").is_empty());

        c.undo().expect("undo restores cleared flows");
        assert_eq!(
            c.shared.store.lock().expect("store").ids(),
            ["a", "b", "c"].map(str::to_string).to_vec(),
            "undo of a clear restores every flow in capture order"
        );
    }

    #[test]
    fn redoing_clear_preserves_traffic_that_arrived_after_the_clear() {
        let c = controller();
        for id in ["a", "b"] {
            c.shared.record_imported(completed_flow(id));
        }
        c.clear_flows_tracked();

        // This request was never part of the clear operation. It must survive
        // both undo and redo of that older history entry.
        c.shared.record_imported(completed_flow("later"));
        c.undo()
            .expect("undo restores the originally-cleared flows");
        assert_eq!(
            c.shared.store.lock().expect("store").ids(),
            ["a", "b", "later"].map(str::to_string).to_vec()
        );

        c.redo().expect("redo removes the originally-cleared flows");
        assert_eq!(
            c.shared.store.lock().expect("store").ids(),
            vec!["later".to_string()],
            "redo must not clear traffic that arrived after the original action"
        );
    }

    #[test]
    fn jump_to_walks_multiple_steps_in_both_directions() {
        let c = controller();
        seed_one_rule(&c);
        for (i, url) in ["/one", "/two", "/three"].iter().enumerate() {
            c.with_history(
                HistoryTag::new(format!("edit {i}"), Some(format!("k{i}"))),
                |ctrl| ctrl.update_rule("A", rule_with_url(url)),
            )
            .expect("update");
        }
        let ids = timeline(&c);
        assert_eq!(ids.len(), 3);

        // Jump back to the oldest entry → rewinds two steps.
        c.jump_to(ids[0]).expect("jump back");
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/one");

        // Jump forward to the newest entry → fast-forwards.
        let last_id = *timeline(&c).last().expect("entry");
        c.jump_to(last_id).expect("jump forward");
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/three");
    }

    #[test]
    fn clear_history_empties_the_timeline() {
        let c = controller();
        seed_one_rule(&c);
        c.with_history(HistoryTag::new("edit", None), |ctrl| {
            ctrl.update_rule("A", rule_with_url("/x"))
        })
        .expect("update");
        assert!(!timeline(&c).is_empty());
        c.clear_history();
        assert!(timeline(&c).is_empty());
        assert!(c.undo().is_none());
    }

    fn flow_with_headers(
        id: &str,
        req_headers: Vec<(&str, &str)>,
        resp_headers: Vec<(&str, &str)>,
        resp_body: &[u8],
    ) -> crate::flow::Flow {
        let mut flow = flow(id);
        flow.request.headers = req_headers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        flow.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: resp_headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: resp_body.to_vec().into(),
            timestamp_ms: 1,
        });
        flow
    }

    fn flow_filter_term(
        field: FlowFilterField,
        side: SearchSide,
        value: &str,
        regex: bool,
        neg: bool,
    ) -> FlowFilterTerm {
        FlowFilterTerm {
            field,
            side,
            value: value.to_string(),
            regex,
            neg,
        }
    }

    fn flow_filter_request(
        key: &str,
        candidates: &[&str],
        terms: Vec<FlowFilterTerm>,
    ) -> FlowFilterRequest {
        FlowFilterRequest {
            key: key.to_string(),
            candidates: candidates.iter().map(|id| (*id).to_string()).collect(),
            terms,
        }
    }

    fn flow_filter_matches(
        controller: &ProxyController,
        candidates: &[&str],
        terms: Vec<FlowFilterTerm>,
    ) -> Vec<String> {
        controller
            .search_flow_filters(&[flow_filter_request("filter", candidates, terms)], || {
                false
            })
            .expect("filter snapshot")
            .filters
            .remove(0)
            .matched
    }

    #[test]
    fn search_headers_matches_request_and_response_header_value() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("x-trace", "zzz")],
            vec![("x-served-by", "edge-7")],
            b"body",
        ));

        assert_eq!(
            c.search_headers("zzz", SearchSide::Either, false, None),
            vec!["f1".to_string()],
            "a request header value is found on Either"
        );
        assert_eq!(
            c.search_headers("zzz", SearchSide::Request, false, None),
            vec!["f1".to_string()],
            "a request header value is found on the Request side"
        );
        assert!(
            c.search_headers("zzz", SearchSide::Response, false, None)
                .is_empty(),
            "a request-only value must not match the Response side"
        );
        assert_eq!(
            c.search_headers("edge-7", SearchSide::Response, false, None),
            vec!["f1".to_string()],
            "a response header value is found on the Response side"
        );
    }

    #[test]
    fn search_headers_is_case_insensitive_substring() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("Authorization", "Bearer ABC")],
            vec![],
            b"body",
        ));

        assert_eq!(
            c.search_headers("authorization", SearchSide::Request, false, None),
            vec!["f1".to_string()],
            "header name match is case-insensitive"
        );
        assert_eq!(
            c.search_headers("bearer abc", SearchSide::Request, false, None),
            vec!["f1".to_string()],
            "header value match is case-insensitive substring"
        );
    }

    #[test]
    fn search_headers_regex() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("x-trace", "zzz")],
            vec![],
            b"body",
        ));

        assert_eq!(
            c.search_headers("x-tr.*", SearchSide::Request, true, None),
            vec!["f1".to_string()],
            "a valid regex matches the rendered header line"
        );
        assert!(
            c.search_headers("x-tr(", SearchSide::Request, true, None)
                .is_empty(),
            "an invalid regex yields an empty result"
        );
    }

    #[test]
    fn search_headers_respects_candidate_prefilter() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "match",
            vec![("x-trace", "zzz")],
            vec![],
            b"body",
        ));
        c.shared.record_new(flow_with_headers(
            "other",
            vec![("x-trace", "zzz")],
            vec![],
            b"body",
        ));

        let only_other = vec!["other".to_string()];
        assert_eq!(
            c.search_headers("zzz", SearchSide::Request, false, Some(&only_other)),
            vec!["other".to_string()],
            "a candidate prefilter excludes a matching id that is not a candidate"
        );
    }

    #[test]
    fn search_cookies_scopes_request_and_response_pairs() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "both",
            vec![("Cookie", "request-id=req-7")],
            vec![("Set-Cookie", "response-id=resp-9; Path=/")],
            b"body",
        ));
        c.shared.record_new(flow_with_headers(
            "request-only",
            vec![("Cookie", "request-id=req-7")],
            vec![],
            b"body",
        ));
        c.shared.record_new(flow_with_headers(
            "response-only",
            vec![],
            vec![("Set-Cookie", "response-id=resp-9; Secure")],
            b"body",
        ));

        assert_eq!(
            c.search_cookies("request-id=req-7", SearchSide::Request, false, None),
            vec!["both".to_string(), "request-only".to_string()]
        );
        assert_eq!(
            c.search_cookies("response-id=resp-9", SearchSide::Response, false, None),
            vec!["both".to_string(), "response-only".to_string()]
        );
        assert_eq!(
            c.search_cookies("resp-9", SearchSide::Either, false, None),
            vec!["both".to_string(), "response-only".to_string()],
            "Either is request OR response"
        );
        assert_eq!(
            c.search_cookies("id=", SearchSide::Either, false, None),
            vec![
                "both".to_string(),
                "request-only".to_string(),
                "response-only".to_string(),
            ],
            "Either unions request and response matches"
        );

        let request_matches =
            c.search_cookies("request-id=req-7", SearchSide::Request, false, None);
        assert_eq!(
            c.search_cookies(
                "response-id=resp-9",
                SearchSide::Response,
                false,
                Some(&request_matches),
            ),
            vec!["both".to_string()],
            "successive req-cookie and resp-cookie terms AND through candidates"
        );
    }

    #[test]
    fn search_cookies_keeps_empty_special_and_duplicate_values() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![
                ("Cookie", "empty=; token=a=b/c+z"),
                ("cookie", "spaced=hello world; duplicate=first"),
            ],
            vec![
                ("Set-Cookie", "duplicate=first; Path=/"),
                ("set-cookie", "duplicate=second; HttpOnly"),
                ("Set-Cookie", "quoted=\"a b=c\"; Secure"),
            ],
            b"body",
        ));

        for (pattern, side) in [
            ("empty=", SearchSide::Request),
            ("token=a=b/c+z", SearchSide::Request),
            ("spaced=hello world", SearchSide::Request),
            ("duplicate=first", SearchSide::Response),
            ("duplicate=second", SearchSide::Response),
            ("quoted=\"a b=c\"", SearchSide::Response),
        ] {
            assert_eq!(
                c.search_cookies(pattern, side, false, None),
                vec!["f1".to_string()],
                "expected cookie pair {pattern:?}"
            );
        }
        assert_eq!(
            c.search_cookies("^duplicate=second$", SearchSide::Response, true, None),
            vec!["f1".to_string()],
            "a regex is evaluated against each duplicate cookie pair separately"
        );
    }

    #[test]
    fn search_cookies_omits_attributes_and_malformed_pairs() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("Cookie", "good=1; broken; =missing-name")],
            vec![
                ("Set-Cookie", "sid=abc; Path=/private; Secure"),
                ("Set-Cookie", "broken; Domain=example.com"),
                ("Set-Cookie", "=missing-name; SameSite=Lax"),
            ],
            b"body",
        ));

        for pattern in [
            "Path=/private",
            "Secure",
            "Domain=example.com",
            "SameSite=Lax",
        ] {
            assert!(
                c.search_cookies(pattern, SearchSide::Response, false, None)
                    .is_empty(),
                "Set-Cookie attribute {pattern:?} is not a cookie pair"
            );
        }
        assert!(
            c.search_cookies("^broken$", SearchSide::Either, true, None)
                .is_empty(),
            "a pair without '=' is omitted"
        );
        assert!(
            c.search_cookies("missing-name", SearchSide::Either, false, None)
                .is_empty(),
            "a pair without a name is omitted"
        );
        assert!(
            c.search_cookies("(", SearchSide::Either, true, None)
                .is_empty(),
            "an invalid regex is a safe no-match"
        );
        assert_eq!(
            c.search_headers("Path=/private", SearchSide::Response, false, None),
            vec!["f1".to_string()],
            "generic header search still sees the unchanged raw header table"
        );
    }

    #[test]
    fn search_cookies_is_case_insensitive_like_other_content_search() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("COOKIE", "Session=AbC")],
            vec![("SET-COOKIE", "Token=XyZ; Path=/")],
            b"body",
        ));

        assert_eq!(
            c.search_cookies("session=abc", SearchSide::Request, false, None),
            vec!["f1".to_string()]
        );
        assert_eq!(
            c.search_cookies("^token=xyz$", SearchSide::Response, true, None),
            vec!["f1".to_string()]
        );
    }

    #[test]
    fn search_bodies_still_skips_binary() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "png",
            vec![],
            vec![
                ("content-type", "image/png"),
                ("x-trace", "needle-in-header"),
            ],
            b"needle-in-body",
        ));

        assert!(
            c.search_bodies("needle-in-body", SearchSide::Response, false, None).is_empty(),
            "the binary (image/png) gate must keep body search from matching ASCII bytes in a binary body"
        );
        assert_eq!(
            c.search_headers("needle-in-header", SearchSide::Response, false, None),
            vec!["png".to_string()],
            "header search has no binary gate and still finds the header value"
        );
    }

    #[test]
    fn search_bodies_unchanged_behavior() {
        let c = controller();
        c.shared.record_new(completed_flow("alpha"));
        c.shared.record_new(completed_flow("beta"));

        assert_eq!(
            c.search_bodies("response-alpha", SearchSide::Response, false, None),
            vec!["alpha".to_string()],
            "body search still matches the decoded text/plain response body"
        );
        assert!(
            c.search_bodies("response-alpha", SearchSide::Request, false, None)
                .is_empty(),
            "a response-body match must not be reported on the Request side"
        );
    }

    #[test]
    fn flow_filter_all_is_url_or_request_response_headers_or_decoded_bodies() {
        let c = controller();
        let mut url = completed_flow("url");
        url.request.path = "/shared-needle".to_string();
        let mut request_header = completed_flow("request-header");
        request_header
            .request
            .headers
            .push(("x-test".to_string(), "shared-needle".to_string()));
        let response_header = flow_with_headers(
            "response-header",
            vec![],
            vec![("x-test", "shared-needle"), ("content-type", "text/plain")],
            b"other",
        );
        let mut request_body = completed_flow("request-body");
        request_body.request.headers = vec![("content-type".into(), "text/plain".into())];
        request_body.request.body = b"shared-needle".to_vec().into();
        let response_body = flow_with_headers(
            "response-body",
            vec![],
            vec![("content-type", "application/json")],
            br#"{"value":"shared-needle"}"#,
        );
        let clean = completed_flow("clean");
        for flow in [
            url,
            request_header,
            response_header,
            request_body,
            response_body,
            clean,
        ] {
            c.shared.record_new(flow);
        }

        let ids = [
            "url",
            "request-header",
            "response-header",
            "request-body",
            "response-body",
            "clean",
        ];
        assert_eq!(
            flow_filter_matches(
                &c,
                &ids,
                vec![flow_filter_term(
                    FlowFilterField::All,
                    SearchSide::Either,
                    "shared-needle",
                    false,
                    false,
                )],
            ),
            ids[..5]
                .iter()
                .map(|id| (*id).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn flow_filter_content_scopes_sides_ands_terms_and_negates_after_or() {
        let c = controller();
        let mut both = completed_flow("both");
        both.request.headers = vec![
            ("content-type".into(), "text/plain".into()),
            ("x-request".into(), "alpha".into()),
        ];
        both.request.body = b"request-beta".to_vec().into();
        if let Some(response) = both.response.as_mut() {
            response
                .headers
                .push(("x-response".into(), "response-beta".into()));
        }
        let mut request_only = completed_flow("request-only");
        request_only.request.headers = vec![("x-request".into(), "alpha".into())];
        let clean = completed_flow("clean");
        for flow in [both, request_only, clean] {
            c.shared.record_new(flow);
        }
        let candidates = ["both", "request-only", "clean"];

        assert_eq!(
            flow_filter_matches(
                &c,
                &candidates,
                vec![
                    flow_filter_term(
                        FlowFilterField::Content,
                        SearchSide::Request,
                        "alpha",
                        false,
                        false,
                    ),
                    flow_filter_term(
                        FlowFilterField::Content,
                        SearchSide::Response,
                        "response-beta",
                        false,
                        false,
                    ),
                ],
            ),
            vec!["both".to_string()]
        );
        assert_eq!(
            flow_filter_matches(
                &c,
                &candidates,
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Either,
                    "alpha|response-beta",
                    true,
                    true,
                )],
            ),
            vec!["clean".to_string()]
        );
    }

    #[test]
    fn flow_filter_content_decodes_gzip_deflate_and_brotli() {
        let c = controller();
        for encoding in ["gzip", "deflate", "br"] {
            let encoded = crate::body::compress_body(encoding, b"decoded-search-needle")
                .expect("encode body");
            c.shared.record_new(flow_with_headers(
                encoding,
                vec![],
                vec![
                    ("content-type", "text/plain"),
                    ("content-encoding", encoding),
                ],
                &encoded,
            ));
        }
        let request_encoded = crate::body::compress_body("gzip", b"decoded-request-needle")
            .expect("encode request body");
        let mut request_gzip = completed_flow("request-gzip");
        request_gzip.request.headers = vec![
            ("content-type".into(), "text/plain".into()),
            ("content-encoding".into(), "gzip".into()),
        ];
        request_gzip.request.body = request_encoded.into();
        c.shared.record_new(request_gzip);
        assert_eq!(
            flow_filter_matches(
                &c,
                &["gzip", "deflate", "br"],
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Response,
                    "decoded-search-needle",
                    false,
                    false,
                )],
            ),
            vec!["gzip".to_string(), "deflate".to_string(), "br".to_string()]
        );
        assert_eq!(
            flow_filter_matches(
                &c,
                &["request-gzip"],
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Request,
                    "decoded-request-needle",
                    false,
                    false,
                )],
            ),
            vec!["request-gzip".to_string()]
        );
    }

    #[test]
    fn filter_body_projection_borrows_identity_text_and_owns_decoded_text_once() {
        let identity = b"identity-search-text";
        let identity_headers = vec![("content-type".to_string(), "text/plain".to_string())];
        let identity_document =
            MessageSearchDocument::new(SearchSide::Request, identity, &identity_headers);
        let identity_text = identity_document.body().expect("identity text");
        assert_eq!(identity_text, "identity-search-text");
        assert_eq!(identity_text.as_ptr(), identity.as_ptr());
        assert!(matches!(
            identity_document.body.get(),
            Some(Some(Cow::Borrowed(_)))
        ));

        let encoded =
            crate::body::compress_body("gzip", b"decoded-search-text").expect("encode body");
        let encoded_headers = vec![
            ("content-type".to_string(), "text/plain".to_string()),
            ("content-encoding".to_string(), "gzip".to_string()),
        ];
        let encoded_document =
            MessageSearchDocument::new(SearchSide::Response, &encoded, &encoded_headers);
        let first = encoded_document.body().expect("decoded text");
        let first_ptr = first.as_ptr();
        assert_eq!(first, "decoded-search-text");
        assert!(matches!(
            encoded_document.body.get(),
            Some(Some(Cow::Owned(_)))
        ));
        assert_eq!(
            encoded_document
                .body()
                .expect("cached decoded text")
                .as_ptr(),
            first_ptr
        );
    }

    #[test]
    fn flow_filter_url_hit_never_projects_a_body() {
        let c = controller();
        let mut candidate = completed_flow("url-hit");
        candidate.request.path = "/url-short-circuit".to_string();
        candidate.request.headers = vec![
            ("content-type".into(), "text/plain".into()),
            ("content-encoding".into(), "gzip".into()),
        ];
        candidate.request.body = crate::body::compress_body("gzip", b"request miss")
            .expect("compress request")
            .into();
        let response = candidate.response.as_mut().expect("response");
        response.headers = candidate.request.headers.clone();
        response.body = crate::body::compress_body("gzip", b"response miss")
            .expect("compress response")
            .into();
        c.shared.record_new(candidate);

        reset_filter_body_projection_stats();
        assert_eq!(
            flow_filter_matches(
                &c,
                &["url-hit"],
                vec![flow_filter_term(
                    FlowFilterField::All,
                    SearchSide::Either,
                    "url-short-circuit",
                    false,
                    false,
                )],
            ),
            vec!["url-hit".to_string()]
        );
        assert_eq!(filter_body_projection_stats(), (0, 0, 0));
    }

    #[test]
    fn flow_filter_request_hit_skips_response_body_projection() {
        let c = controller();
        let mut candidate = completed_flow("request-hit");
        candidate.request.headers = vec![
            ("content-type".into(), "text/plain".into()),
            ("content-encoding".into(), "gzip".into()),
        ];
        candidate.request.body = crate::body::compress_body("gzip", b"request-side-needle")
            .expect("compress request")
            .into();
        let response = candidate.response.as_mut().expect("response");
        response.headers = candidate.request.headers.clone();
        response.body = crate::body::compress_body("gzip", b"response miss")
            .expect("compress response")
            .into();
        c.shared.record_new(candidate);

        reset_filter_body_projection_stats();
        assert_eq!(
            flow_filter_matches(
                &c,
                &["request-hit"],
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Either,
                    "request-side-needle",
                    false,
                    false,
                )],
            ),
            vec!["request-hit".to_string()]
        );
        let (projections, retained, peak) = filter_body_projection_stats();
        assert_eq!(projections, 1);
        assert_eq!(retained, 0);
        assert_eq!(peak, b"request-side-needle".len());
    }

    #[test]
    fn flow_filter_releases_one_large_side_before_decoding_the_other() {
        let c = controller();
        let request_text = format!("request-marker{}", "a".repeat(2 * 1024 * 1024));
        let response_text = format!("response-marker{}", "b".repeat(2 * 1024 * 1024));
        let mut candidate = completed_flow("two-large-sides");
        candidate.request.headers = vec![
            ("content-type".into(), "text/plain".into()),
            ("content-encoding".into(), "gzip".into()),
        ];
        candidate.request.body = crate::body::compress_body("gzip", request_text.as_bytes())
            .expect("compress request")
            .into();
        let response = candidate.response.as_mut().expect("response");
        response.headers = candidate.request.headers.clone();
        response.body = crate::body::compress_body("gzip", response_text.as_bytes())
            .expect("compress response")
            .into();
        c.shared.record_new(candidate);

        reset_filter_body_projection_stats();
        assert_eq!(
            flow_filter_matches(
                &c,
                &["two-large-sides"],
                vec![
                    flow_filter_term(
                        FlowFilterField::Body,
                        SearchSide::Request,
                        "request-marker",
                        false,
                        false,
                    ),
                    flow_filter_term(
                        FlowFilterField::Body,
                        SearchSide::Response,
                        "response-marker",
                        false,
                        false,
                    ),
                ],
            ),
            vec!["two-large-sides".to_string()]
        );
        let (projections, retained, peak) = filter_body_projection_stats();
        assert_eq!(projections, 2);
        assert_eq!(retained, 0);
        assert_eq!(peak, request_text.len().max(response_text.len()));
    }

    #[test]
    fn flow_filter_content_skips_binary_body_but_keeps_raw_headers() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "body-only",
            vec![],
            vec![("content-type", "image/png")],
            b"binary-needle",
        ));
        c.shared.record_new(flow_with_headers(
            "header",
            vec![],
            vec![("content-type", "image/png"), ("x-test", "binary-needle")],
            b"other",
        ));
        assert_eq!(
            flow_filter_matches(
                &c,
                &["body-only", "header"],
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Response,
                    "binary-needle",
                    false,
                    false,
                )],
            ),
            vec!["header".to_string()]
        );
    }

    #[test]
    fn flow_filter_cookie_projection_keeps_duplicates_and_excludes_attributes() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "cookie",
            vec![("Cookie", "duplicate=first; duplicate=second")],
            vec![("Set-Cookie", "sid=abc; Path=/private")],
            b"body",
        ));
        for value in ["duplicate=first", "duplicate=second", "sid=abc"] {
            assert_eq!(
                flow_filter_matches(
                    &c,
                    &["cookie"],
                    vec![flow_filter_term(
                        FlowFilterField::Cookies,
                        SearchSide::Either,
                        value,
                        false,
                        false,
                    )],
                ),
                vec!["cookie".to_string()]
            );
        }
        assert!(flow_filter_matches(
            &c,
            &["cookie"],
            vec![flow_filter_term(
                FlowFilterField::Cookies,
                SearchSide::Response,
                "Path=/private",
                false,
                false,
            )],
        )
        .is_empty());
        assert_eq!(
            flow_filter_matches(
                &c,
                &["cookie"],
                vec![flow_filter_term(
                    FlowFilterField::Content,
                    SearchSide::Response,
                    "Path=/private",
                    false,
                    false,
                )],
            ),
            vec!["cookie".to_string()]
        );
    }

    #[test]
    fn flow_filter_invalid_regex_is_safe_and_candidates_are_unique() {
        let c = controller();
        c.shared.record_new(completed_flow("one"));
        assert!(flow_filter_matches(
            &c,
            &["one", "one"],
            vec![flow_filter_term(
                FlowFilterField::All,
                SearchSide::Either,
                "(",
                true,
                false,
            )],
        )
        .is_empty());
        assert_eq!(
            flow_filter_matches(
                &c,
                &["one", "one"],
                vec![flow_filter_term(
                    FlowFilterField::All,
                    SearchSide::Either,
                    "(",
                    true,
                    true,
                )],
            ),
            vec!["one".to_string()]
        );
    }

    #[test]
    fn flow_filter_batch_cancels_without_returning_partial_results() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let c = controller();
        for id in ["one", "two", "three"] {
            c.shared.record_new(completed_flow(id));
        }
        let checks = AtomicUsize::new(0);
        let result = c
            .search_flow_filters(
                &[flow_filter_request(
                    "filter",
                    &["one", "two", "three"],
                    vec![flow_filter_term(
                        FlowFilterField::All,
                        SearchSide::Either,
                        "response",
                        false,
                        false,
                    )],
                )],
                || checks.fetch_add(1, Ordering::Relaxed) >= 2,
            )
            .expect("filter snapshot");
        assert!(result.cancelled);
        assert!(result.filters.is_empty());
    }

    #[test]
    fn flow_filter_batch_matches_with_the_store_lock_released() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let c = controller();
        c.shared.record_new(completed_flow("one"));
        let checks = AtomicUsize::new(0);
        let result = c
            .search_flow_filters(
                &[flow_filter_request(
                    "filter",
                    &["one"],
                    vec![flow_filter_term(
                        FlowFilterField::Content,
                        SearchSide::Response,
                        "response-one",
                        false,
                        false,
                    )],
                )],
                || {
                    if checks.fetch_add(1, Ordering::Relaxed) > 0 {
                        assert!(c.shared.store.try_lock().is_ok());
                    }
                    false
                },
            )
            .expect("filter snapshot");
        assert_eq!(result.filters[0].matched, vec!["one".to_string()]);
    }

    #[test]
    fn flow_filter_batch_uses_one_coherent_candidate_union_snapshot() {
        let c = controller();
        for id in ["removed", "replaced", "outside"] {
            let mut candidate = completed_flow(id);
            candidate.response.as_mut().expect("response").body = b"snapshot-needle"[..].into();
            c.shared.record_new(candidate);
        }

        let request = flow_filter_request(
            "filter",
            &["removed", "replaced"],
            vec![flow_filter_term(
                FlowFilterField::Content,
                SearchSide::Response,
                "snapshot-needle",
                false,
                false,
            )],
        );
        let result = c
            .search_flow_filters_with_snapshot_hook(
                &[request],
                || false,
                || {
                    let mut store = c.shared.store.lock().expect("snapshot lock was released");
                    store.remove(&["removed".to_string()]);
                    let mut replacement = completed_flow("replaced");
                    replacement.response.as_mut().expect("response").body =
                        b"replacement-does-not-match"[..].into();
                    store.insert(replacement);
                },
            )
            .expect("coherent snapshot");

        assert_eq!(
            result.filters[0].matched,
            vec!["removed".to_string(), "replaced".to_string()]
        );
        assert!(
            !result.filters[0].matched.contains(&"outside".to_string()),
            "an unrequested matching flow is never copied into the bounded snapshot"
        );
    }

    #[test]
    fn flow_filter_snapshot_lock_poison_is_an_error_not_an_empty_success() {
        let c = controller();
        c.shared.record_new(completed_flow("one"));
        let shared = Arc::clone(&c.shared);
        assert!(std::thread::spawn(move || {
            let _store = shared.store.lock().expect("lock store before poison");
            panic!("poison filter snapshot lock");
        })
        .join()
        .is_err());

        let error = c
            .search_flow_filters(
                &[flow_filter_request(
                    "filter",
                    &["one"],
                    vec![flow_filter_term(
                        FlowFilterField::All,
                        SearchSide::Either,
                        "one",
                        false,
                        false,
                    )],
                )],
                || false,
            )
            .expect_err("a poisoned snapshot must not become a successful empty miss");
        assert!(error.to_string().contains("filter snapshot"));
    }

    #[test]
    fn content_scan_runs_with_the_store_lock_released() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let c = controller();
        c.shared.record_new(completed_flow("alpha"));

        let probed = AtomicBool::new(false);
        let ids = c.search_messages(
            "response-alpha",
            SearchSide::Either,
            false,
            None,
            |_side, body, _headers| {
                // Live capture (`record_new` / `record_complete`) needs exactly
                // this mutex: it must be acquirable while the scan decodes and
                // matches bodies, or a big search stalls the proxy hot path.
                assert!(
                    c.shared.store.try_lock().is_ok(),
                    "the store lock must not be held during the content scan"
                );
                probed.store(true, Ordering::Relaxed);
                Some(vec![String::from_utf8_lossy(body).into_owned()])
            },
        );
        assert!(
            probed.load(Ordering::Relaxed),
            "the scan must actually have run"
        );
        assert_eq!(ids, vec!["alpha".to_string()], "scan results are unchanged");
    }

    #[test]
    fn mock_prep_progress_fires_with_the_store_lock_released() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let c = controller();
        c.shared.record_new(completed_flow("m1"));
        c.shared.record_new(completed_flow("m2"));

        let calls = AtomicUsize::new(0);
        let batch = c.prepare_mock_flows(
            &["m1".to_string(), "m2".to_string()],
            None,
            |_done, total| {
                // The progress callback is on the bulk-mock path; firing it
                // under the store lock would stall capture for the whole build.
                assert!(
                    c.shared.store.try_lock().is_ok(),
                    "progress must not fire while the store lock is held"
                );
                assert_eq!(total, 2);
                calls.fetch_add(1, Ordering::Relaxed);
            },
        );
        assert_eq!(
            calls.load(Ordering::Relaxed),
            2,
            "one progress tick per requested id"
        );
        assert_eq!(batch.rules.len(), 2, "both flows produced a rule");
    }

    #[test]
    fn search_rules_empty_pattern_returns_all_ids() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario(
                "S",
                vec![respond_rule("one"), respond_rule("two")],
            )],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "", RuleSearchScope::All),
            vec!["one".to_string(), "two".to_string()],
            "an empty pattern returns every rule id in the scenario"
        );
    }

    #[test]
    fn search_rules_by_url() {
        let c = controller();
        let mut a = respond_rule("a");
        a.matcher.url = "https://example.com/login".to_string();
        let mut b = respond_rule("b");
        b.matcher.url = "https://example.com/health".to_string();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a, b])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "/health", RuleSearchScope::Url),
            vec!["b".to_string()],
        );
    }

    #[test]
    fn search_rules_by_method() {
        let c = controller();
        let mut a = respond_rule("a");
        a.matcher.method = Some("POST".to_string());
        let mut b = respond_rule("b");
        b.matcher.method = Some("GET".to_string());
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a, b])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "post", RuleSearchScope::Method),
            vec!["a".to_string()],
        );
    }

    #[test]
    fn search_rules_by_status_matches_respond_and_setstatus() {
        let c = controller();
        let mut down = respond_rule("down");
        down.action = Action::Respond {
            status: 503,
            headers: vec![],
            body: String::new(),
            body_base64: None,
            content_type: None,
            content_encoding: None,
        };
        let teapot = Rule {
            id: "teapot".to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::SetStatus { status: 418 },
        };
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![down, teapot])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "503", RuleSearchScope::Status),
            vec!["down".to_string()],
        );
        assert_eq!(
            c.search_rules("S", "418", RuleSearchScope::Status),
            vec!["teapot".to_string()],
        );
    }

    #[test]
    fn search_rules_by_response_body() {
        let c = controller();
        let mut a = respond_rule("a");
        a.action = Action::Respond {
            status: 200,
            headers: vec![],
            body: "needle-XYZ in the body".to_string(),
            body_base64: None,
            content_type: Some("text/plain".to_string()),
            content_encoding: None,
        };
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a, respond_rule("b")])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "xyz", RuleSearchScope::Response),
            vec!["a".to_string()],
            "response-body search is case-insensitive substring"
        );
    }

    #[test]
    fn search_rules_by_headers_matches_set_header_value_and_respond_header() {
        let c = controller();
        let mut respond = respond_rule("respond");
        respond.action = Action::Respond {
            status: 200,
            headers: vec![("x-a".to_string(), "val1".to_string())],
            body: String::new(),
            body_base64: None,
            content_type: Some("application/json".to_string()),
            content_encoding: None,
        };
        let set_header = Rule {
            id: "set-header".to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher::default(),
            action: Action::SetResponseHeader {
                name: "x-b".to_string(),
                value: "val2".to_string(),
            },
        };
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![respond, set_header])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "val1", RuleSearchScope::Headers),
            vec!["respond".to_string()],
            "a Respond header value is searchable",
        );
        assert_eq!(
            c.search_rules("S", "x-b", RuleSearchScope::Headers),
            vec!["set-header".to_string()],
            "a SetResponseHeader name is searchable",
        );
        assert_eq!(
            c.search_rules("S", "json", RuleSearchScope::Headers),
            vec!["respond".to_string()],
            "the Respond content-type is included in the Headers scope",
        );
    }

    #[test]
    fn search_rules_all_unions_scopes() {
        let c = controller();
        let mut a = respond_rule("a");
        a.matcher = Matcher::default();
        a.action = Action::Respond {
            status: 200,
            headers: vec![],
            body: "only-in-body-needle".to_string(),
            body_base64: None,
            content_type: None,
            content_encoding: None,
        };
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a, respond_rule("b")])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "only-in-body-needle", RuleSearchScope::All),
            vec!["a".to_string()],
            "a needle present only in the body still matches under All",
        );
    }

    #[test]
    fn search_rules_missing_scenario_returns_empty() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![respond_rule("a")])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert!(
            c.search_rules("ghost", "a", RuleSearchScope::Url)
                .is_empty(),
            "searching a non-existent scenario returns empty",
        );
        assert!(
            c.search_rules("ghost", "", RuleSearchScope::All).is_empty(),
            "even an empty pattern returns empty for a missing scenario",
        );
    }

    #[test]
    fn search_rules_is_substring_not_regex() {
        let c = controller();
        let mut a = respond_rule("a");
        a.matcher.url = "x-a value".to_string();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert!(
            c.search_rules("S", "x-a.*", RuleSearchScope::Url)
                .is_empty(),
            "rule search is plain substring, so a regex metacharacter pattern does not match",
        );
        assert_eq!(
            c.search_rules("S", "x-a", RuleSearchScope::Url),
            vec!["a".to_string()],
            "the literal prefix still matches as a substring",
        );
    }

    #[test]
    fn search_headers_with_empty_headers_neither_panics_nor_matches() {
        let c = controller();
        c.shared.record_new(flow("bare"));

        assert!(
            c.search_headers("anything", SearchSide::Either, false, None)
                .is_empty(),
            "a flow with empty request headers and no response yields no header match",
        );
    }

    #[test]
    fn search_headers_either_finds_response_only_match() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "f1",
            vec![("x-trace", "req-only")],
            vec![("x-served-by", "resp-only")],
            b"body",
        ));

        assert_eq!(
            c.search_headers("resp-only", SearchSide::Either, false, None),
            vec!["f1".to_string()],
            "Either must reach the response side when the request header misses (the !req && resp branch)",
        );
    }

    #[test]
    fn search_bodies_either_returns_each_id_once_when_both_sides_match() {
        let c = controller();
        let mut both = flow("both");
        both.request.headers = vec![("content-type".to_string(), "text/plain".to_string())];
        both.request.body = b"shared-needle in request".to_vec().into();
        both.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"shared-needle in response".to_vec().into(),
            timestamp_ms: 1,
        });
        c.shared.record_new(both);

        assert_eq!(
            c.search_bodies("shared-needle", SearchSide::Either, false, None),
            vec!["both".to_string()],
            "a flow whose request and response both match on Either is reported exactly once",
        );
    }

    #[test]
    fn search_rules_includes_disabled_rules() {
        let c = controller();
        let mut off = respond_rule("off");
        off.enabled = false;
        off.matcher.url = "https://example.com/login".to_string();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![off])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "login", RuleSearchScope::Url),
            vec!["off".to_string()],
            "rule search ignores the enabled flag and still finds a disabled rule",
        );
        assert_eq!(
            c.search_rules("S", "", RuleSearchScope::All),
            vec!["off".to_string()],
            "an empty pattern returns disabled rule ids too",
        );
    }

    #[test]
    fn search_rules_method_scope_skips_rules_with_no_method() {
        let c = controller();
        let no_method = respond_rule("no-method");
        let mut posted = respond_rule("posted");
        posted.matcher.method = Some("POST".to_string());
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![no_method, posted])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "post", RuleSearchScope::Method),
            vec!["posted".to_string()],
            "a rule whose matcher.method is None must not match a non-empty Method needle",
        );
    }

    #[test]
    fn search_rules_all_matches_via_headers_only() {
        let c = controller();
        let mut a = respond_rule("a");
        a.matcher = Matcher::default();
        a.action = Action::Respond {
            status: 200,
            headers: vec![("x-flavor".to_string(), "sprinkles".to_string())],
            body: String::new(),
            body_base64: None,
            content_type: None,
            content_encoding: None,
        };
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![a, respond_rule("b")])],
            active_scenario_id: Some("S".to_string()),
            general_active: true,
        });

        assert_eq!(
            c.search_rules("S", "sprinkles", RuleSearchScope::All),
            vec!["a".to_string()],
            "All unions the Headers scope, so a value present only in a response header still matches",
        );
    }

    #[test]
    fn controller_seeds_general_by_default() {
        let c = controller();
        let ar = c.get_autoresponder();
        assert!(
            ar.general().is_some(),
            "a fresh controller has the built-in General scenario"
        );
        assert_eq!(ar.scenarios[0].id, GENERAL_SCENARIO_ID, "General is first");
        assert!(ar.general_active, "General is on by default");
    }

    #[test]
    fn generated_scenario_names_ignore_general_and_do_not_reuse_existing_numbers() {
        let c = controller();
        let mut initial = AutoResponder::default();
        initial.ensure_general();
        c.set_autoresponder(initial);

        let first = c.create_scenario(None).expect("create first scenario");
        assert_eq!(first.name, "Scenario 1");
        c.rename_scenario(&first.id, "Scenario 7".to_string())
            .expect("seed a higher generated number");
        let next = c.create_scenario(None).expect("create next scenario");
        assert_eq!(next.name, "Scenario 8");
    }

    #[test]
    fn general_scenario_is_protected() {
        let c = controller();
        assert!(
            c.set_active_scenario(Some(GENERAL_SCENARIO_ID)).is_err(),
            "General cannot be the active scenario"
        );
        assert!(
            c.delete_scenario(GENERAL_SCENARIO_ID).is_err(),
            "General cannot be deleted"
        );
        assert!(
            c.rename_scenario(GENERAL_SCENARIO_ID, "Nope".to_string())
                .is_err(),
            "General cannot be renamed"
        );
        assert!(
            c.get_autoresponder().general().is_some(),
            "General still present after the rejected mutations"
        );
    }

    #[test]
    fn set_general_active_toggles_and_persists_in_state() {
        let c = controller();
        c.set_general_active(false).expect("toggle off");
        assert!(!c.get_autoresponder().general_active);
        c.set_general_active(true).expect("toggle on");
        assert!(c.get_autoresponder().general_active);
    }
}
