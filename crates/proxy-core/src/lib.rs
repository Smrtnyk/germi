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
mod session;
mod shared;
mod store;
mod tester;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::Proxy;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, Mutex};

pub use ca::CertAuthority;
pub use flow::{FlowDetail, FlowEvent, FlowSummary, MessageDetail, ResourceKind};
pub use rules::{Action, AutoResponder, MatchKind, Matcher, Rule, RuleSet, Scenario};
pub use tester::{test_rules, TestInput, TestResponse, TestResult};

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
    ca: CertAuthority,
    /// `Some(shutdown_sender)` while the proxy is running.
    running: Mutex<Option<oneshot::Sender<()>>>,
}

impl ProxyController {
    /// Build a controller around an already-loaded CA. Seeds an example scenario.
    pub fn new(ca: CertAuthority) -> Self {
        Self {
            shared: Shared::new(MAX_FLOWS, AutoResponder::example()),
            ca,
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
        self.ca.cert_pem.clone()
    }

    pub fn ca_cert_der(&self) -> Vec<u8> {
        self.ca.cert_der.clone()
    }

    pub async fn is_running(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// Start the proxy listening on `addr`. Errors if already running.
    pub async fn start(&self, addr: SocketAddr) -> Result<()> {
        let mut guard = self.running.lock().await;
        if guard.is_some() {
            bail!("proxy is already running");
        }

        // Install a default crypto provider once (ignored if already set).
        let _ = aws_lc_rs::default_provider().install_default();

        let authority = self.ca.to_authority()?;
        let handler = CaptureHandler::new(self.shared.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let proxy = Proxy::builder()
            .with_addr(addr)
            .with_ca(authority)
            .with_rustls_connector(aws_lc_rs::default_provider())
            .with_http_handler(handler.clone())
            .with_websocket_handler(handler)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .build()
            .map_err(|e| anyhow!("failed to build proxy: {e:?}"))?;

        tokio::spawn(async move {
            if let Err(e) = proxy.start().await {
                tracing::error!("proxy exited with error: {e}");
            }
        });

        *guard = Some(shutdown_tx);
        Ok(())
    }

    /// Gracefully stop the proxy if running.
    pub async fn stop(&self) {
        if let Some(tx) = self.running.lock().await.take() {
            let _ = tx.send(());
        }
    }

    // ---- captured-flow access (for IPC commands) ----

    pub fn list_flows(&self) -> Vec<FlowSummary> {
        self.shared
            .store
            .lock()
            .map(|s| s.summaries())
            .unwrap_or_default()
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
        let ids = candidates
            .map(|c| c.to_vec())
            .unwrap_or_else(|| store.ids());

        let hit = |body: &[u8], headers: &[(String, String)]| -> bool {
            if !crate::flow::is_textual(headers) {
                return false; // skip binary blobs (images/fonts/media)
            }
            let bytes = match crate::body::content_encoding_of(headers) {
                Some(enc) => {
                    crate::body::try_decompress(&enc, body).unwrap_or_else(|| body.to_vec())
                }
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
                        .map(|r| hit(&r.body, &r.headers))
                        .unwrap_or(false);
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
        if let Ok(mut guard) = self.shared.autoresponder.write() {
            *guard = autoresponder;
        }
    }

    /// Seed Respond rules from the given captured flows and add them to a
    /// scenario (the given id, else the active one, else a new "My mocks"),
    /// which becomes active. Returns the updated autoresponder + new rule ids.
    pub fn mock_flows(&self, ids: &[String], scenario_id: Option<&str>) -> MockResult {
        let flows: Vec<crate::flow::Flow> = match self.shared.store.lock() {
            Ok(store) => ids.iter().filter_map(|id| store.get(id).cloned()).collect(),
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
        let mut new_rule_ids = Vec::new();
        if let Some(scenario) = ar.scenarios.iter_mut().find(|s| s.id == target_id) {
            let base = crate::flow::now_ms();
            for (i, flow) in flows.iter().enumerate() {
                let rid = format!("rule-{base}-{i}");
                new_rule_ids.push(rid.clone());
                scenario.rules.push(rules::respond_rule_from_flow(flow, rid));
            }
        }

        self.set_autoresponder(ar.clone());
        MockResult {
            autoresponder: ar,
            new_rule_ids,
        }
    }
}
