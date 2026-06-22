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
mod rules;
mod rules_export;
mod session;
mod settings;
mod shared;
mod store;
mod tester;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, bail, Result};
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::Proxy;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::task::JoinHandle;

pub use ca::CertAuthority;
pub use flow::{FlowDetail, FlowEvent, FlowSummary, MessageDetail, ResourceKind};
pub use history::{HistoryEntryView, HistoryKind, HistoryTag, HistoryView};
pub use rules::{
    Action, ActionSummary, AutoResponder, AutoResponderSummary, MatchKind, Matcher, Rule,
    RuleSet, RuleSummary, Scenario, ScenarioSummary,
};
pub use rules_export::RulesExport;
pub use settings::ProxySettings;
pub use tester::{test_rules, SequenceStep, TestInput, TestResponse, TestResult};

use handler::CaptureHandler;
use history::{HistoryEntry, HistoryOp};
use shared::Shared;

/// Maximum number of flows retained in memory before oldest are evicted.
const MAX_FLOWS: usize = 5_000;
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

/// Owns the proxy lifecycle, the captured-flow store and the rules.
pub struct ProxyController {
    shared: Arc<Shared>,
    /// Behind a lock so the CA can be regenerated at runtime.
    ca: RwLock<CertAuthority>,
    /// `Some((shutdown_sender, task))` while the proxy is running. The join
    /// handle lets `stop()` wait for the listener to actually release.
    running: Mutex<Option<(oneshot::Sender<()>, JoinHandle<()>)>>,
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

    /// Start the proxy listening on `addr`. Errors if already running, or if the
    /// bind fails (e.g. the port is in use). Returns the actually-bound address
    /// (e.g. resolving port 0 to the OS-assigned port).
    pub async fn start(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let mut guard = self.running.lock().await;
        if guard.is_some() {
            bail!("proxy is already running");
        }

        // Install a default crypto provider once (ignored if already set).
        let _ = aws_lc_rs::default_provider().install_default();

        // Bind here (not inside the spawned task) so a bind failure propagates to
        // the caller BEFORE we record the proxy as running — otherwise the UI
        // would show "running" while the proxy had actually died on bind.
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

        *guard = Some((shutdown_tx, task));
        Ok(local_addr)
    }

    /// Gracefully stop the proxy if running. Waits for the proxy task to finish
    /// (the listener socket is released) before returning, so an immediate
    /// restart on the same port doesn't fail with "address already in use".
    pub async fn stop(&self) {
        let taken = self.running.lock().await.take();
        if let Some((tx, task)) = taken {
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
            if !crate::flow::is_textual(headers) {
                return false; // skip binary blobs (images/fonts/media)
            }
            let bytes = match crate::body::decode_body(headers, body) {
                Some((decoded, _truncated)) => decoded,
                None => body.to_vec(),
            };
            let text = String::from_utf8_lossy(&bytes);
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

    // ---- import (HAR / SAZ) ----

    /// Import a HAR archive's entries as flows. Returns the count imported.
    pub fn import_har(&self, bytes: &[u8]) -> Result<usize> {
        Ok(self.import_flows(import::parse_har(bytes)?))
    }

    /// Import a Fiddler SAZ archive's sessions as flows.
    pub fn import_saz(&self, bytes: &[u8]) -> Result<usize> {
        Ok(self.import_flows(import::parse_saz(bytes)?))
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

    /// Replace the current traffic with the flows from a `.germi` session.
    pub fn import_session(&self, bytes: &[u8]) -> Result<usize> {
        let flows = session::import_session(bytes)?;
        self.clear_flows();
        Ok(self.import_flows(flows))
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
            ar.scenarios.clear();
            ar.active_scenario_id = None;
        }
        let mut taken: std::collections::HashSet<String> =
            ar.scenarios.iter().map(|s| s.name.clone()).collect();
        for mut scenario in imported {
            scenario.name = rules_export::dedupe_name(&mut taken, &scenario.name);
            ar.scenarios.push(scenario);
        }

        self.set_autoresponder(ar);
        Ok(count)
    }

    /// Insert imported flows (assigning ids) and stream them to the UI.
    fn import_flows(&self, flows: Vec<crate::flow::Flow>) -> usize {
        let mut count = 0;
        for mut flow in flows {
            flow.id = self.shared.next_id();
            self.shared.record_imported(flow);
            count += 1;
        }
        count
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
        // Only the active scenario is ever evaluated, so only its rule ids have
        // meaningful cursors — scope retention to those.
        let live: std::collections::HashSet<String> = autoresponder
            .active()
            .map(|s| s.rules.iter().map(|r| r.id.clone()).collect())
            .unwrap_or_default();

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
        let live: std::collections::HashSet<&str> = autoresponder
            .active()
            .map(|scenario| scenario.rules.iter().map(|rule| rule.id.as_str()).collect())
            .unwrap_or_default();
        if let Ok(mut cursors) = self.shared.cursors.lock() {
            if previous_active == autoresponder.active_scenario_id.as_deref() {
                cursors.reset_missing(&live);
            } else {
                cursors.reset();
            }
        }
    }

    pub fn set_active_scenario(&self, scenario_id: Option<&str>) -> Result<()> {
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
        copy.name = format!("{} copy", copy.name);
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
            store.set_max(max);
        }
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

    fn respond_rule(id: &str) -> Rule {
        Rule {
            id: id.to_string(),
            name: id.to_string(),
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
            request: request(),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
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
                    name: "Large".to_string(),
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("B", vec![respond_rule("b-rule")])],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, false).expect("import");
        assert_eq!(count, 1);

        let ar = dst.get_autoresponder();
        assert_eq!(ar.scenarios.len(), 2, "merge appends the imported scenario");
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: "y".to_string(),
                name: "My mocks".to_string(),
                rules: vec![],
            }],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        let names: Vec<String> = dst.get_autoresponder().scenarios.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["My mocks".to_string(), "My mocks (2)".to_string()]);
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("C", vec![respond_rule("c-rule")])],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, true).expect("replace import");
        assert_eq!(count, 1);

        let ar = dst.get_autoresponder();
        assert_eq!(ar.scenarios.len(), 1, "replace wipes the existing scenarios");
        assert_eq!(ar.scenarios[0].name, "C");
        assert_ne!(ar.scenarios[0].id, "C", "the replaced-in scenario is re-keyed");
        assert_ne!(ar.scenarios[0].rules[0].id, "c-rule", "its rule is re-keyed too");
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("Only", vec![respond_rule("only-rule")])],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        let count = dst.import_rules(&bytes, true).expect("replace into empty");
        assert_eq!(count, 1);
        let ar = dst.get_autoresponder();
        assert_eq!(ar.scenarios.len(), 1, "replace into an empty config yields exactly the import");
        assert_eq!(ar.scenarios[0].name, "Only");
        assert_eq!(ar.active_scenario_id, None, "still Off after replace into empty");
    }

    #[test]
    fn import_one_file_with_duplicate_names_dedupes_within_file() {
        let dst = controller();
        dst.set_autoresponder(AutoResponder {
            scenarios: vec![],
            active_scenario_id: None,
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                Scenario { id: "a".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "b".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "c".into(), name: "Set".into(), rules: vec![] },
            ],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        let names: Vec<String> = dst.get_autoresponder().scenarios.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            names,
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![
                Scenario { id: "a".into(), name: "Set".into(), rules: vec![] },
                Scenario { id: "b".into(), name: "Set".into(), rules: vec![] },
            ],
            active_scenario_id: None,
        });
        let bytes = src.export_rules(None);

        dst.import_rules(&bytes, false).expect("import");
        let names: Vec<String> = dst.get_autoresponder().scenarios.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            names,
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
        });

        let src = controller();
        src.set_autoresponder(AutoResponder {
            scenarios: vec![scenario("B", vec![respond_rule("b-rule")])],
            active_scenario_id: None,
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
        });
    }

    fn renamed_rule(name: &str) -> Rule {
        let mut rule = respond_rule("r1");
        rule.name = name.to_string();
        rule
    }

    #[test]
    fn mock_edit_undo_redo_round_trips() {
        let c = controller();
        seed_one_rule(&c);

        c.with_history(HistoryTag::new("Edit rule", None), |ctrl| {
            ctrl.update_rule("A", renamed_rule("Renamed"))
        })
        .expect("update");
        assert_eq!(c.get_rule("r1").expect("rule").name, "Renamed");

        let step = c.undo().expect("undo");
        assert!(step.mock_changed, "a mock undo must signal the caller to re-persist");
        assert!(!step.view.can_undo && step.view.can_redo);
        assert_eq!(c.get_rule("r1").expect("rule").name, "r1", "undo restores the prior name");

        let step = c.redo().expect("redo");
        assert!(step.mock_changed);
        assert_eq!(c.get_rule("r1").expect("rule").name, "Renamed", "redo re-applies the edit");
    }

    #[test]
    fn coalesced_edits_undo_as_a_single_step() {
        let c = controller();
        seed_one_rule(&c);
        let key = Some("edit:r1:name".to_string());
        for name in ["a", "ab", "abc"] {
            c.with_history(HistoryTag::new("Edit rule name", key.clone()), |ctrl| {
                ctrl.update_rule("A", renamed_rule(name))
            })
            .expect("update");
        }
        assert_eq!(c.get_rule("r1").expect("rule").name, "abc");
        assert_eq!(
            c.history_view().entries.len(),
            1,
            "three same-key edits collapse to one undo entry"
        );

        c.undo().expect("undo");
        assert_eq!(
            c.get_rule("r1").expect("rule").name,
            "r1",
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
        for (i, name) in ["one", "two", "three"].iter().enumerate() {
            c.with_history(HistoryTag::new(format!("edit {i}"), Some(format!("k{i}"))), |ctrl| {
                ctrl.update_rule("A", renamed_rule(name))
            })
            .expect("update");
        }
        let entries = c.history_view().entries;
        assert_eq!(entries.len(), 3);

        // Jump back to the oldest entry → rewinds two steps.
        c.jump_to(entries[0].id).expect("jump back");
        assert_eq!(c.get_rule("r1").expect("rule").name, "one");

        // Jump forward to the newest entry → fast-forwards.
        let last_id = c.history_view().entries.last().expect("entry").id;
        c.jump_to(last_id).expect("jump forward");
        assert_eq!(c.get_rule("r1").expect("rule").name, "three");
    }

    #[test]
    fn clear_history_empties_the_timeline() {
        let c = controller();
        seed_one_rule(&c);
        c.with_history(HistoryTag::new("edit", None), |ctrl| {
            ctrl.update_rule("A", renamed_rule("x"))
        })
        .expect("update");
        assert!(!c.history_view().entries.is_empty());
        c.clear_history();
        assert!(c.history_view().entries.is_empty());
        assert!(c.undo().is_none());
    }
}
