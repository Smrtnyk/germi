//! State shared between every cloned proxy handler instance and the controller.
//!
//! Locks are held only for the brief synchronous critical sections (insert /
//! update / read rules) and never across an `.await`, so plain std `Mutex` /
//! `RwLock` are correct and cheaper than their async cousins here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::broadcast;

use crate::flow::{CapturedRequest, CapturedResponse, Flow, FlowEvent};
use crate::rules::AutoResponder;
use crate::store::FlowStore;

pub struct Shared {
    pub store: Mutex<FlowStore>,
    pub autoresponder: RwLock<AutoResponder>,
    pub events: broadcast::Sender<FlowEvent>,
    counter: AtomicU64,
}

impl Shared {
    pub fn new(max_flows: usize, autoresponder: AutoResponder) -> Arc<Self> {
        // Generous buffer; slow subscribers get a Lagged error and resync rather
        // than blocking the proxy.
        let (events, _rx) = broadcast::channel(10_000);
        Arc::new(Self {
            store: Mutex::new(FlowStore::new(max_flows)),
            autoresponder: RwLock::new(autoresponder),
            events,
            counter: AtomicU64::new(1),
        })
    }

    pub fn next_id(&self) -> String {
        format!("f{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    /// Record a freshly-captured request (response pending) and emit `New`.
    pub fn record_new(&self, flow: Flow) {
        let summary = flow.summary();
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
        matched_rule: Option<String>,
    ) {
        let summary = {
            let Ok(mut store) = self.store.lock() else {
                return;
            };
            store.set_response(id, resp, duration_ms, matched_rule);
            store.get(id).map(|f| f.summary())
        };
        if let Some(summary) = summary {
            let _ = self.events.send(FlowEvent::Completed { summary });
        }
    }

    /// Insert an already-complete imported flow and emit it as `Completed`
    /// (the frontend upserts by id, so a single Completed adds the row).
    pub fn record_imported(&self, flow: Flow) {
        let summary = flow.summary();
        if let Ok(mut store) = self.store.lock() {
            store.insert(flow);
        }
        let _ = self.events.send(FlowEvent::Completed { summary });
    }

    /// Clone of a recorded request, for response-phase rule evaluation.
    pub fn get_request(&self, id: &str) -> Option<CapturedRequest> {
        self.store
            .lock()
            .ok()
            .and_then(|store| store.get(id).map(|f| f.request.clone()))
    }
}
