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
mod flow;
mod handler;
mod history;
mod import;
mod reissue;
mod rules;
mod rules_export;
mod scripting;
mod session;
mod settings;
mod shared;
mod store;
mod tester;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

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
pub use history::{HistoryEntryView, HistoryKind, HistoryTag, HistoryView};
pub use rules::{
    Action, ActionSummary, AutoResponder, AutoResponderSummary, MatchKind, Matcher, Rule,
    RuleSearchScope, RuleSet, RuleSummary, Scenario, ScenarioSummary, GENERAL_SCENARIO_ID,
    GENERAL_SCENARIO_NAME,
};
pub use rules_export::RulesExport;
pub use scripting::{Script, ScriptDiagnostic};
pub use settings::ProxySettings;
pub use tester::{test_rules, SequenceStep, TestInput, TestResponse, TestResult};

use handler::CaptureHandler;
use history::{HistoryEntry, HistoryOp};
use shared::Shared;

/// Maximum number of flows retained in memory before oldest are evicted.
const MAX_FLOWS: usize = 5_000;
/// Max concurrent outbound availability checks (bounds load + open sockets).
const AVAILABILITY_CONCURRENCY: usize = 12;
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

/// Outcome of an undo/redo/jump: the new timeline view to hand the UI, plus
/// whether the autoresponder changed (so the Tauri layer re-persists it).
pub struct HistoryStep {
    pub view: HistoryView,
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

/// Which side(s) of a flow `search_bodies` scans.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SearchSide {
    Request,
    Response,
    Either,
}

/// Which projection of a flow a content search scans.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SearchField {
    Body,
    Headers,
}

/// A live proxy: its bound address, a shutdown signal, and the serving task's
/// join handle (so `stop()` can wait for the listener socket to be released).
type RunningProxy = (SocketAddr, oneshot::Sender<()>, JoinHandle<()>);

/// Owns the proxy lifecycle, the captured-flow store and the rules.
pub struct ProxyController {
    shared: Arc<Shared>,
    /// Behind a lock so the CA can be regenerated at runtime.
    ca: RwLock<CertAuthority>,
    /// `Some(..)` while the proxy is running; the bound address lets the UI
    /// re-read the live listen port/scope after a webview reload.
    running: Mutex<Option<RunningProxy>>,
}

impl ProxyController {
    /// Build a controller around an already-loaded CA. Seeds an example scenario.
    pub fn new(ca: CertAuthority) -> Self {
        Self {
            shared: Shared::new(MAX_FLOWS, AutoResponder::example(), ProxySettings::default()),
            ca: RwLock::new(ca),
            running: Mutex::new(None),
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
        self.ca.read().map(|c| c.cert_pem.clone()).unwrap_or_default()
    }

    pub fn ca_cert_der(&self) -> Vec<u8> {
        self.ca.read().map(|c| c.cert_der.clone()).unwrap_or_default()
    }

    /// Generate a fresh root CA, persist it under `dir`, and swap it in. The
    /// proxy must be stopped (the running proxy holds the old authority); the
    /// user must re-trust the new CA afterwards.
    pub async fn regenerate_ca(&self, dir: &Path) -> Result<()> {
        // Hold the `running` lock across the whole swap so a concurrent start()
        // cannot read the old CA and bake it into a freshly-spawned proxy in the
        // window between the check and the swap (check-then-act TOCTOU).
        let running = self.running.lock().await;
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
        self.running.lock().await.is_some()
    }

    /// The address the proxy is currently bound to, or `None` if stopped. Lets the
    /// UI re-read the live listen address (port + LAN scope) after a reload,
    /// instead of guessing from the persisted setting.
    pub async fn bound_addr(&self) -> Option<SocketAddr> {
        self.running.lock().await.as_ref().map(|(addr, _, _)| *addr)
    }

    /// Start the proxy listening on `addr`. Errors if already running, or if the
    /// bind fails (e.g. the port is in use). Returns the actually-bound address
    /// (e.g. resolving port 0 to the OS-assigned port).
    pub async fn start(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let mut guard = self.running.lock().await;
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
        let state = self.spawn_proxy(addr).await?;
        let local_addr = state.0;
        if let Some((_addr, tx, task)) = guard.take() {
            let _ = tx.send(());
            let _ = task.await;
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
        let taken = self.running.lock().await.take();
        if let Some((_addr, tx, task)) = taken {
            let _ = tx.send(());
            let _ = task.await;
        }
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
                    Some((
                        id.clone(),
                        reissue::ReissueTarget {
                            method,
                            // Rebuild the absolute URL: intercepted-HTTPS captures
                            // store an origin-form URI (just the path).
                            url: format!("{}://{}{}", req.scheme, req.host, req.path),
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
        if let Ok(mut store) = self.shared.store.lock() {
            store.clear();
        }
        let _ = self.shared.events.send(FlowEvent::Cleared);
    }

    /// Remove specific captured flows by id, so the user can prune noise before
    /// saving a `.germi` session. Emits `Removed` with the ids (the UI drops
    /// those rows); a no-op that emits nothing when none of the ids were present.
    pub fn remove_flows(&self, ids: &[String]) {
        let removed = match self.shared.store.lock() {
            Ok(mut store) => store.remove(ids),
            Err(_) => 0,
        };
        if removed > 0 {
            let _ = self.shared.events.send(FlowEvent::Removed { ids: ids.to_vec() });
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
        self.search_messages(pattern, side, regex, candidates, |body, headers| {
            if !crate::flow::is_textual(headers) {
                return None; // skip binary blobs (images/fonts/media)
            }
            let bytes = match crate::body::decode_body(headers, body) {
                Some((decoded, _truncated)) => decoded,
                None => body.to_vec(),
            };
            Some(String::from_utf8_lossy(&bytes).into_owned())
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
        self.search_messages(pattern, side, regex, candidates, |_body, headers| {
            Some(
                headers
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
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
        Some(BodyComparison { request_equal, response_equal })
    }

    /// Shared scan core for body/header content search. `extract` projects a
    /// message (body + headers) to the searchable text, or `None` to skip that
    /// message (e.g. a binary body). Per flow the request side wins first, then
    /// the response, matching the original `search_bodies` short-circuit.
    fn search_messages(
        &self,
        pattern: &str,
        side: SearchSide,
        regex: bool,
        candidates: Option<&[String]>,
        extract: impl Fn(&[u8], &[(String, String)]) -> Option<String>,
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

        let Ok(store) = self.shared.store.lock() else {
            return Vec::new();
        };
        let ids = candidates.map_or_else(|| store.ids(), |c| c.to_vec());

        let hit = |body: &[u8], headers: &[(String, String)]| -> bool {
            let Some(text) = extract(body, headers) else {
                return false;
            };
            match &re {
                Some(re) => re.is_match(&text),
                None => text.to_lowercase().contains(&needle),
            }
        };

        ids.into_iter()
            .filter(|id| {
                let Some(flow) = store.get(id) else {
                    return false;
                };
                let req = matches!(side, SearchSide::Request | SearchSide::Either)
                    && hit(&flow.request.body, &flow.request.headers);
                let resp = !req
                    && matches!(side, SearchSide::Response | SearchSide::Either)
                    && flow
                        .response
                        .as_ref()
                        .is_some_and(|r| hit(&r.body, &r.headers));
                req || resp
            })
            .collect()
    }

    // ---- capture files: open (.germi / .har / .saz) + session export ----

    /// Parse a capture file — a `.germi` session, a HAR, or a Fiddler SAZ
    /// archive — into flows, dispatched on the lowercased `ext`.
    fn parse_capture(bytes: &[u8], ext: &str) -> Result<Vec<crate::flow::Flow>> {
        match ext {
            "germi" => session::import_session(bytes),
            "har" => import::parse_har(bytes),
            "saz" => import::parse_saz(bytes),
            other => bail!("Unsupported file type: .{other}"),
        }
    }

    /// Open a capture file, REPLACING the current traffic. Returns the number
    /// of flows loaded. The file is fully parsed before anything is cleared,
    /// so a malformed file leaves traffic intact.
    pub fn open_capture(&self, bytes: &[u8], ext: &str) -> Result<usize> {
        let flows = Self::parse_capture(bytes, ext)?;
        self.clear_flows();
        self.shared.reset_seq();
        Ok(self.import_flows(flows).len())
    }

    /// Append a capture file to the current traffic WITHOUT clearing it — for
    /// loading a reference session into the compare view's right side (issue
    /// #86). Appended flows carry the `imported` marker and request numbering
    /// continues (only a replacing open renumbers from 1). Returns the new
    /// flows' summaries in file order, so the caller can address exactly them.
    pub fn append_capture(&self, bytes: &[u8], ext: &str) -> Result<Vec<FlowSummary>> {
        Ok(self.import_flows(Self::parse_capture(bytes, ext)?))
    }

    /// Serialize the current traffic to a `.germi` session (JSON bytes).
    pub fn export_session(&self) -> Vec<u8> {
        let flows = self
            .shared
            .store
            .lock()
            .map(|s| s.all_flows())
            .unwrap_or_default();
        session::export_session(&flows)
    }

    // ---- autoresponder rules export / import (.germi-rules) ----

    /// Serialize scenarios to a portable `.germi-rules` bundle. With `Some(id)`
    /// only that scenario is exported (empty bundle if it's not found); `None`
    /// exports the whole config. The active-scenario pointer is never carried.
    pub fn export_rules(&self, scenario_id: Option<&str>) -> Vec<u8> {
        let ar = self.get_autoresponder();
        let selected: Vec<Scenario> = match scenario_id {
            Some(id) => ar.scenarios.into_iter().filter(|s| s.id == id).collect(),
            None => ar.scenarios,
        };
        rules_export::export_rules(&selected)
    }

    /// Import scenarios from a `.germi-rules` bundle. Imported scenarios are
    /// always re-keyed (fresh scenario + rule ids) so they can never alias an
    /// existing rule's hit counter. `replace == false` appends them (active
    /// pointer preserved); `replace == true` clears existing scenarios and resets
    /// the active pointer to Off (importing must not silently start mocking).
    /// Returns the number of scenarios imported.
    pub fn import_rules(&self, bytes: &[u8], replace: bool) -> Result<usize> {
        let imported = rules_export::parse_rules(bytes)?;
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
        let mut taken: std::collections::HashSet<String> =
            ar.scenarios.iter().map(|s| s.name.clone()).collect();
        for mut scenario in imported {
            scenario.name = rules_export::dedupe_name(&mut taken, &scenario.name);
            ar.scenarios.push(scenario);
        }

        // Guarantee the built-in General scenario exists and stays first, even
        // when neither the current config nor the bundle carried one.
        ar.ensure_general();
        self.set_autoresponder(ar);
        Ok(count)
    }

    /// Insert imported flows (assigning ids) and stream them to the UI.
    /// Returns their summaries in insertion order.
    fn import_flows(&self, flows: Vec<crate::flow::Flow>) -> Vec<FlowSummary> {
        let mut summaries = Vec::with_capacity(flows.len());
        for mut flow in flows {
            flow.id = self.shared.next_id();
            flow.seq = self.shared.next_seq();
            summaries.push(flow.summary());
            self.shared.record_imported(flow);
        }
        summaries
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
                || format!("Scenario {}", ar.scenarios.len() + 1),
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
        scenario.rules.retain(|rule| !doomed.contains(rule.id.as_str()));
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
        let evicted = match self.shared.store.lock() {
            Ok(mut store) => store.set_max(max),
            Err(_) => Vec::new(),
        };
        if !evicted.is_empty() {
            let _ = self.shared.events.send(FlowEvent::Removed { ids: evicted });
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
        self.shared.scripts.read().ok().and_then(|engine| engine.check(source))
    }

    /// Build mock rules without changing live state. Callers can report progress,
    /// persist the batch transactionally, then commit it atomically.
    pub fn prepare_mock_flows(
        &self,
        ids: &[String],
        scenario_id: Option<&str>,
        mut on_progress: impl FnMut(usize, usize),
    ) -> MockBatch {
        let rules = match self.shared.store.lock() {
            Ok(store) => {
                let mut rules = Vec::with_capacity(ids.len());
                for (index, id) in ids.iter().enumerate() {
                    let Some(flow) = store.get(id) else {
                        on_progress(index + 1, ids.len());
                        continue;
                    };
                    let rule_id = new_entity_id("rule");
                    rules.push(rules::respond_rule_from_flow(flow, rule_id));
                    on_progress(index + 1, ids.len());
                }
                rules
            }
            Err(_) => Vec::new(),
        };

        let ar = self.get_autoresponder();
        let scenario_id = scenario_id
            .map(str::to_string)
            .or(ar.active_scenario_id)
            .unwrap_or_else(|| new_entity_id("scenario"));
        let create_scenario = !ar.scenarios.iter().any(|scenario| scenario.id == scenario_id);
        MockBatch {
            scenario_id,
            scenario_name: "My mocks".to_string(),
            create_scenario,
            rules,
        }
    }

    pub fn commit_mock_batch(&self, batch: MockBatch) -> Result<MockResult> {
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
        ar.active_scenario_id = Some(batch.scenario_id.clone());
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
        self.commit_mock_batch(batch).unwrap_or_else(|_| MockResult {
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
        let before = self.get_autoresponder();
        let result = mutation(self)?;
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
        let items = match self.shared.store.lock() {
            Ok(mut store) => store.remove_capturing(ids),
            Err(_) => Vec::new(),
        };
        if items.is_empty() {
            return;
        }
        let removed_ids: Vec<String> = items.iter().map(|(_, flow)| flow.id.clone()).collect();
        let _ = self.shared.events.send(FlowEvent::Removed { ids: removed_ids });
        let label = format!(
            "Delete {} flow{}",
            items.len(),
            if items.len() == 1 { "" } else { "s" }
        );
        if let Ok(mut history) = self.shared.history.lock() {
            history.record(HistoryOp::FlowsRemoved { items }, HistoryTag::new(label, None));
        }
    }

    /// Remove every live-captured (non-imported) flow, keeping the flows that were
    /// loaded from a file (HAR / SAZ / `.germi`). This is the "clear the replay
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
        let flows = match self.shared.store.lock() {
            Ok(mut store) => {
                let all = store.all_flows();
                store.clear();
                all
            }
            Err(_) => Vec::new(),
        };
        let _ = self.shared.events.send(FlowEvent::Cleared);
        if flows.is_empty() {
            return;
        }
        let label = format!(
            "Clear traffic ({} flow{})",
            flows.len(),
            if flows.len() == 1 { "" } else { "s" }
        );
        if let Ok(mut history) = self.shared.history.lock() {
            history.record(HistoryOp::FlowsCleared { flows }, HistoryTag::new(label, None));
        }
    }

    pub fn history_view(&self) -> HistoryView {
        self.shared
            .history
            .lock()
            .map(|history| history.view())
            .unwrap_or_default()
    }

    pub fn clear_history(&self) {
        if let Ok(mut history) = self.shared.history.lock() {
            history.clear();
        }
    }

    /// Undo the newest action. Returns the new timeline view and whether the
    /// autoresponder changed (so the caller re-persists it); `None` when there is
    /// nothing to undo.
    pub fn undo(&self) -> Option<HistoryStep> {
        let entry = self.shared.history.lock().ok()?.take_undo()?;
        let mock_changed = self.apply_undo(&entry);
        let mut history = self.shared.history.lock().ok()?;
        history.stash_redo(entry);
        Some(HistoryStep {
            view: history.view(),
            mock_changed,
        })
    }

    /// Redo the most recently undone action.
    pub fn redo(&self) -> Option<HistoryStep> {
        let entry = self.shared.history.lock().ok()?.take_redo()?;
        let mock_changed = self.apply_redo(&entry);
        let mut history = self.shared.history.lock().ok()?;
        history.stash_undo(entry);
        Some(HistoryStep {
            view: history.view(),
            mock_changed,
        })
    }

    /// Undo or redo until the entry with `entry_id` is the current state (the top
    /// of the applied stack). A no-op when the id isn't in the timeline.
    pub fn jump_to(&self, entry_id: u64) -> Option<HistoryStep> {
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
            let step = if in_undo { self.undo() } else { self.redo() };
            match step {
                Some(step) => mock_changed |= step.mock_changed,
                None => break,
            }
        }
        Some(HistoryStep {
            view: self.history_view(),
            mock_changed,
        })
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
            HistoryOp::FlowsCleared { .. } => {
                self.clear_flows();
                false
            }
        }
    }

    /// Re-insert flows (with their capture positions) and tell the UI to re-list.
    fn restore_flows(&self, items: Vec<(usize, crate::flow::Flow)>) {
        if let Ok(mut store) = self.shared.store.lock() {
            store.restore(items);
        }
        let _ = self.shared.events.send(FlowEvent::Resync);
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

    fn request() -> CapturedRequest {
        CapturedRequest {
            method: "GET".to_string(),
            uri: "https://example.com/seq".to_string(),
            scheme: "https".to_string(),
            host: "example.com".to_string(),
            path: "/seq".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![],
            body: vec![],
            timestamp_ms: 0,
        }
    }

    fn fire_active_once(controller: &ProxyController) {
        let ar = controller.shared.autoresponder.read().expect("read autoresponder");
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
            body: format!("response-{id}").into_bytes(),
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
                    summary.availability.expect("verdict on emitted row").verdict,
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
            assert!(store.get("f2").is_some(), "an unselected flow survives the prune");
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
            ["imp1", "cap1", "imp2", "cap2"].map(str::to_string).to_vec(),
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
        c.set_settings(ProxySettings { max_flows: 2, ..Default::default() });

        {
            let store = c.shared.store.lock().expect("lock store");
            assert!(store.get("imp").is_some(), "imported reference survives a cap shrink");
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
            c.list_flows().iter().find(|s| s.id == "live").map(|s| s.imported),
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
        assert_eq!(seqs, vec![1, 2, 3], "request numbers increase in capture order");
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
        let bytes = crate::session::export_session(&[flow("x"), flow("y")]);
        let n = c.open_capture(&bytes, "germi").expect("open germi");
        assert_eq!(n, 2);
        let seqs: Vec<u64> = c.list_flows().into_iter().map(|s| s.seq).collect();
        assert_eq!(seqs, vec![1, 2], "an opened session is numbered 1..N, not continued");
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
        assert_eq!(store.len(), 2, "open replaces — the seeded flow is gone, not appended to");
        assert!(store.get("stale").is_none());
    }

    #[test]
    fn open_capture_germi_round_trips_and_replaces() {
        let c = controller();
        c.shared.record_new(flow("stale"));
        let bytes = crate::session::export_session(&[flow("a"), flow("b")]);
        let n = c.open_capture(&bytes, "germi").expect("open germi");
        assert_eq!(n, 2);
        assert_eq!(c.shared.store.lock().expect("lock store").len(), 2);
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
        assert_eq!(store.len(), 3, "append adds to the traffic instead of replacing it");
        assert!(store.get("live").is_some(), "existing traffic survives the append");
    }

    #[test]
    fn append_capture_continues_request_numbering() {
        let c = controller();
        let mut live = flow("live");
        live.seq = c.shared.next_seq();
        c.shared.record_new(live);
        let bytes = crate::session::export_session(&[flow("x")]);
        let appended = c.append_capture(&bytes, "germi").expect("append germi");
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
        f.request.body = req_body.to_vec();
        f.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: resp_headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: resp_body.to_vec(),
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
        c.shared.record_new(flow_with_bodies("plain", b"ask", &[], b"same payload"));
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
        c.shared.record_new(flow_with_bodies("a", b"same-req", &[], b"payload-a"));
        c.shared.record_new(flow_with_bodies("b", b"same-req", &[], b"payload-b"));
        let cmp = c.compare_bodies("a", "b").expect("both flows exist");
        assert!(cmp.request_equal, "identical request bodies compare equal");
        assert_eq!(cmp.response_equal, Some(false), "differing response bodies are reported");
    }

    #[test]
    fn compare_bodies_is_none_per_side_without_a_response_and_overall_for_unknown_ids() {
        let c = controller();
        c.shared.record_new(flow("pending"));
        c.shared.record_new(completed_flow("done"));
        let cmp = c.compare_bodies("pending", "done").expect("both flows exist");
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
                vec![respond_rule("one"), respond_rule("two"), respond_rule("three")],
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
        assert_eq!(user_names(&ar), vec!["A", "B"], "merge appends the imported scenario");
        assert!(ar.general().is_some(), "the built-in General layer stays present");
        assert_eq!(
            ar.active_scenario_id.as_deref(),
            Some("A"),
            "merge must not steal the active selection"
        );
        let imported = ar.scenarios.iter().find(|s| s.name == "B").expect("imported B");
        assert_ne!(imported.id, "B", "imported scenario must be re-keyed");
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
        assert_eq!(only_a.len(), 1, "exporting one id yields exactly that scenario");
        assert_eq!(only_a[0].name, "A");

        let missing = rules_export::parse_rules(&c.export_rules(Some("missing"))).expect("parse missing");
        assert!(missing.is_empty(), "exporting an unknown id yields an empty bundle");
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
        let clone = ar.scenarios.iter().rev().find(|s| s.name == "A (2)").expect("imported clone");
        let clone_rule_id = &clone.rules[0].id;
        assert_ne!(
            clone_rule_id, "seq-rule",
            "the imported rule must be re-keyed away from the original id"
        );
        assert_eq!(
            c.rule_hits().get(clone_rule_id.as_str()).copied().unwrap_or(0),
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
        assert_eq!(user_names(&ar), vec!["C"], "replace wipes the existing user scenarios");
        assert!(ar.general().is_some(), "the built-in General layer survives a replace");
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
        assert!(ar.general().is_some(), "General is seeded even into an empty config");
        assert_eq!(ar.active_scenario_id, None, "still Off after replace into empty");
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
                Scenario { id: "a".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "b".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "c".into(), name: "Set".into(), rules: vec![] },
            ],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        assert_eq!(
            user_names(&dst.get_autoresponder()),
            vec!["Set".to_string(), "Set (2)".to_string(), "Set (3)".to_string()],
            "duplicate names inside a single imported file are de-duped in order"
        );
    }

    #[test]
    fn merge_dedupes_against_existing_and_within_file() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario { id: "x".into(), name: "Set".into(), rules: vec![] }],
            active_scenario_id: None,
            general_active: true,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                Scenario { id: "a".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "b".into(), name: "Set".into(), rules: vec![] },
            ],
            active_scenario_id: None,
            general_active: true,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        assert_eq!(
            user_names(&dst.get_autoresponder()),
            vec!["Set".to_string(), "Set (2)".to_string(), "Set (3)".to_string()],
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
                ctrl.delete_rules("A", &["r1".to_string(), "gone".to_string(), "r3".to_string()])
            })
            .expect("delete_rules");
        assert_eq!(removed, 2, "only the two present ids are counted as removed");

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
        assert_eq!(remaining, vec!["r2".to_string()], "r1 and r3 are gone, r2 stays");
        assert_eq!(c.history_view().entries.len(), 1, "a batch delete is a single undo entry");

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
            c.history_view().entries.is_empty(),
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
        assert!(step.mock_changed, "a mock undo must signal the caller to re-persist");
        assert!(!step.view.can_undo && step.view.can_redo);
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/seq", "undo restores the prior url");

        let step = c.redo().expect("redo");
        assert!(step.mock_changed);
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/edited", "redo re-applies the edit");
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
            c.history_view().entries.len(),
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
        assert!(c.history_view().entries.is_empty(), "an identical update records nothing");

        // Failed update (missing scenario) → nothing recorded.
        let failed = c.with_history(HistoryTag::new("fail", None), |ctrl| {
            ctrl.update_rule("missing", respond_rule("r1"))
        });
        assert!(failed.is_err());
        assert!(c.history_view().entries.is_empty(), "a failed mutation records nothing");
        assert!(c.undo().is_none(), "nothing to undo");
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
        assert_eq!(c.get_autoresponder().active_scenario_id.as_deref(), Some("B"));

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
        assert!(!step.mock_changed, "a traffic undo never touches the autoresponder");
        {
            let store = c.shared.store.lock().expect("store");
            assert_eq!(
                store.ids(),
                ["a", "b", "c", "d"].map(str::to_string).to_vec(),
                "undo restores the exact capture order"
            );
            let body = &store.get("b").expect("flow b is back").response.as_ref().expect("resp").body;
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
    fn jump_to_walks_multiple_steps_in_both_directions() {
        let c = controller();
        seed_one_rule(&c);
        for (i, url) in ["/one", "/two", "/three"].iter().enumerate() {
            c.with_history(HistoryTag::new(format!("edit {i}"), Some(format!("k{i}"))), |ctrl| {
                ctrl.update_rule("A", rule_with_url(url))
            })
            .expect("update");
        }
        let entries = c.history_view().entries;
        assert_eq!(entries.len(), 3);

        // Jump back to the oldest entry → rewinds two steps.
        c.jump_to(entries[0].id).expect("jump back");
        assert_eq!(c.get_rule("r1").expect("rule").matcher.url, "/one");

        // Jump forward to the newest entry → fast-forwards.
        let last_id = c.history_view().entries.last().expect("entry").id;
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
        assert!(!c.history_view().entries.is_empty());
        c.clear_history();
        assert!(c.history_view().entries.is_empty());
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
            body: resp_body.to_vec(),
            timestamp_ms: 1,
        });
        flow
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
            c.search_headers("zzz", SearchSide::Response, false, None).is_empty(),
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
            c.search_headers("x-tr(", SearchSide::Request, true, None).is_empty(),
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
    fn search_bodies_still_skips_binary() {
        let c = controller();
        c.shared.record_new(flow_with_headers(
            "png",
            vec![],
            vec![("content-type", "image/png"), ("x-trace", "needle-in-header")],
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
            c.search_bodies("response-alpha", SearchSide::Request, false, None).is_empty(),
            "a response-body match must not be reported on the Request side"
        );
    }

    #[test]
    fn search_rules_empty_pattern_returns_all_ids() {
        let c = controller();
        c.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("S", vec![respond_rule("one"), respond_rule("two")])],
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
            c.search_rules("ghost", "a", RuleSearchScope::Url).is_empty(),
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
            c.search_rules("S", "x-a.*", RuleSearchScope::Url).is_empty(),
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
            c.search_headers("anything", SearchSide::Either, false, None).is_empty(),
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
        both.request.body = b"shared-needle in request".to_vec();
        both.response = Some(CapturedResponse {
            status: 200,
            version: "HTTP/1.1".to_string(),
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"shared-needle in response".to_vec(),
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
        assert!(ar.general().is_some(), "a fresh controller has the built-in General scenario");
        assert_eq!(ar.scenarios[0].id, GENERAL_SCENARIO_ID, "General is first");
        assert!(ar.general_active, "General is on by default");
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
            c.rename_scenario(GENERAL_SCENARIO_ID, "Nope".to_string()).is_err(),
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
