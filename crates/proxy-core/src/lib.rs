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
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, bail, Result};
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::Proxy;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::task::JoinHandle;

pub use ca::CertAuthority;
pub use flow::{FlowDetail, FlowEvent, FlowSummary, MessageDetail, ResourceKind};
pub use rules::{Action, AutoResponder, MatchKind, Matcher, Rule, RuleSet, Scenario};
pub use rules_export::RulesExport;
pub use settings::ProxySettings;
pub use tester::{test_rules, SequenceStep, TestInput, TestResponse, TestResult};

use handler::CaptureHandler;
use shared::Shared;

/// Maximum number of flows retained in memory before oldest are evicted.
const MAX_FLOWS: usize = 5_000;

/// Result of bulk-mocking flows into a scenario.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MockResult {
    pub autoresponder: AutoResponder,
    pub new_rule_ids: Vec<String>,
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

    /// Seed Respond rules from the given captured flows and add them to a
    /// scenario (the given id, else the active one, else a new "My mocks"),
    /// which becomes active. Returns the updated autoresponder + new rule ids.
    pub fn mock_flows(&self, ids: &[String], scenario_id: Option<&str>) -> MockResult {
        let base = crate::flow::now_ms();
        let new_rules: Vec<(String, Rule)> = match self.shared.store.lock() {
            Ok(store) => ids
                .iter()
                .filter_map(|id| store.get(id))
                .enumerate()
                .map(|(i, flow)| {
                    let rule_id = format!("rule-{base}-{i}");
                    let rule = rules::respond_rule_from_flow(flow, rule_id.clone());
                    (rule_id, rule)
                })
                .collect(),
            Err(_) => Vec::new(),
        };

        let mut ar = self.get_autoresponder();

        let target_id = scenario_id
            .map(|s| s.to_string())
            .or_else(|| ar.active_scenario_id.clone())
            .unwrap_or_else(|| format!("scenario-{}", crate::flow::now_ms()));
        if !ar.scenarios.iter().any(|s| s.id == target_id) {
            ar.scenarios.push(Scenario {
                id: target_id.clone(),
                name: "My mocks".to_string(),
                rules: Vec::new(),
            });
        }
        ar.active_scenario_id = Some(target_id.clone());

        // One rule per request — no collapsing (Fiddler-style).
        let mut new_rule_ids = Vec::with_capacity(new_rules.len());
        if let Some(scenario) = ar.scenarios.iter_mut().find(|s| s.id == target_id) {
            scenario.rules.reserve(new_rules.len());
            for (rule_id, rule) in new_rules {
                new_rule_ids.push(rule_id);
                scenario.rules.push(rule);
            }
        }

        self.set_autoresponder(ar.clone());
        MockResult {
            autoresponder: ar,
            new_rule_ids,
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
        let scenario = result
            .autoresponder
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
}
