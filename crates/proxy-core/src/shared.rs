//! State shared between every cloned proxy handler instance and the controller.
//!
//! Locks are held only for the brief synchronous critical sections (insert /
//! update / read rules) and never across an `.await`, so plain std `Mutex` /
//! `RwLock` are correct and cheaper than their async cousins here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::broadcast;

use crate::flow::{
    extract_header_columns, CapturedRequest, CapturedResponse, Flow, FlowEvent,
};
use crate::history::History;
use crate::rules::{AutoResponder, RuleCursors};
use crate::settings::ProxySettings;
use crate::store::FlowStore;

pub struct Shared {
    pub store: Mutex<FlowStore>,
    pub autoresponder: RwLock<AutoResponder>,
    pub settings: RwLock<ProxySettings>,
    pub cursors: Mutex<RuleCursors>,
    pub history: Mutex<History>,
    pub events: broadcast::Sender<FlowEvent>,
    counter: AtomicU64,
}

impl Shared {
    pub fn new(
        max_flows: usize,
        autoresponder: AutoResponder,
        settings: ProxySettings,
    ) -> Arc<Self> {
        // Generous buffer; slow subscribers get a Lagged error and resync rather
        // than blocking the proxy.
        let (events, _rx) = broadcast::channel(10_000);
        Arc::new(Self {
            store: Mutex::new(FlowStore::new(max_flows)),
            autoresponder: RwLock::new(autoresponder),
            settings: RwLock::new(settings),
            cursors: Mutex::new(RuleCursors::default()),
            history: Mutex::new(History::default()),
            events,
            counter: AtomicU64::new(1),
        })
    }

    /// Whether `host` is configured to bypass interception (tunneled / unrecorded):
    /// it's excluded, or a non-empty capture include-filter doesn't match it.
    pub fn should_bypass(&self, host: &str) -> bool {
        self.settings
            .read()
            .is_ok_and(|s| s.is_excluded(host) || !s.matches_capture_filter(host))
    }

    /// Artificial delay (ms) to add before returning each response (0 = off).
    pub fn response_delay_ms(&self) -> u64 {
        self.settings
            .read()
            .map_or(0, |s| s.response_delay_ms)
    }

    pub fn next_id(&self) -> String {
        format!("f{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    /// The header-column specs the user has pinned (for `extract_header_columns`).
    pub(crate) fn header_cols(&self) -> Vec<String> {
        self.settings
            .read()
            .map(|s| s.header_columns.clone())
            .unwrap_or_default()
    }

    /// Record a freshly-captured request (response pending) and emit `New`.
    pub fn record_new(&self, flow: Flow) {
        let cols = self.header_cols();
        let mut summary = flow.summary();
        summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), &cols);
        if let Ok(mut store) = self.store.lock() {
            store.insert(flow);
        }
        let _ = self.events.send(FlowEvent::New { summary });
    }

    /// Attach a response to a recorded flow and emit `Completed`.
    pub fn record_complete(
        &self,
        id: &str,
        resp: CapturedResponse,
        duration_ms: u64,
        ttfb_ms: Option<u64>,
        matched_rule: Option<String>,
    ) {
        let cols = self.header_cols();
        let summary = {
            let Ok(mut store) = self.store.lock() else {
                return;
            };
            store.set_response(id, resp, duration_ms, ttfb_ms, matched_rule);
            store.get(id).map(|f| {
                let mut s = f.summary();
                s.extra = extract_header_columns(&f.request, f.response.as_ref(), &cols);
                s
            })
        };
        if let Some(summary) = summary {
            let _ = self.events.send(FlowEvent::Completed { summary });
        }
    }

    /// Insert an already-complete imported flow and emit it as `Completed`
    /// (the frontend upserts by id, so a single Completed adds the row).
    pub fn record_imported(&self, flow: Flow) {
        let cols = self.header_cols();
        let mut summary = flow.summary();
        summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), &cols);
        if let Ok(mut store) = self.store.lock() {
            store.insert(flow);
        }
        let _ = self.events.send(FlowEvent::Completed { summary });
    }

    /// Set (or clear) a flow's user comment and emit the updated row.
    pub fn set_comment(&self, id: &str, comment: Option<String>) {
        let cols = self.header_cols();
        let summary = {
            let Ok(mut store) = self.store.lock() else {
                return;
            };
            store.set_comment(id, comment);
            store.get(id).map(|f| {
                let mut s = f.summary();
                s.extra = extract_header_columns(&f.request, f.response.as_ref(), &cols);
                s
            })
        };
        if let Some(summary) = summary {
            let _ = self.events.send(FlowEvent::Completed { summary });
        }
    }

    /// Record a flow's public-availability verdict and emit the updated row (the
    /// frontend upserts by id, so the inline icon refreshes live).
    pub fn set_availability(&self, id: &str, availability: crate::flow::Availability) {
        let cols = self.header_cols();
        let summary = {
            let Ok(mut store) = self.store.lock() else {
                return;
            };
            if !store.set_availability(id, availability) {
                return;
            }
            store.get(id).map(|f| {
                let mut s = f.summary();
                s.extra = extract_header_columns(&f.request, f.response.as_ref(), &cols);
                s
            })
        };
        if let Some(summary) = summary {
            let _ = self.events.send(FlowEvent::Completed { summary });
        }
    }

    /// Clone of a recorded request, for response-phase rule evaluation.
    pub fn get_request(&self, id: &str) -> Option<CapturedRequest> {
        self.store
            .lock()
            .ok()
            .and_then(|store| store.get(id).map(|f| f.request.clone()))
    }
}
