//! State shared between every cloned proxy handler instance and the controller.
//!
//! Locks are held only for the brief synchronous critical sections (insert /
//! update / read rules) and never across an `.await`, so plain std `Mutex` /
//! `RwLock` are correct and cheaper than their async cousins here.
//!
//! `FlowEvent`s are emitted while the store lock is still held, so each store
//! mutation and its event are atomic: a send after unlocking lets a concurrent
//! insert deliver `Removed{X}` (or `Cleared`) before `New{X}` reaches the
//! channel — a permanent ghost row in the UI (the issue-#80 class this event
//! system exists to prevent). `broadcast::send` is synchronous and never
//! blocks, so it adds no hold time and takes no other lock (no ordering risk).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::broadcast;

use crate::flow::{extract_header_columns, CapturedResponse, Flow, FlowEvent};
use crate::history::History;
use crate::rules::{AutoResponder, RuleCursors};
use crate::scripting::ScriptEngine;
use crate::settings::ProxySettings;
use crate::store::FlowStore;

pub struct Shared {
    pub store: Mutex<FlowStore>,
    pub autoresponder: RwLock<AutoResponder>,
    pub scripts: RwLock<ScriptEngine>,
    pub settings: RwLock<ProxySettings>,
    pub cursors: Mutex<RuleCursors>,
    pub history: Mutex<History>,
    /// Serializes a complete before/mutate/after history transaction. The data
    /// locks above remain fine-grained; this lock only orders authored changes.
    pub history_ops: Mutex<()>,
    /// Orders sequence assignment with flow insertion and file imports. A
    /// replacing open holds this across clear/reset/the full imported batch, so
    /// a live request cannot slip into the new document with a duplicate or
    /// out-of-order request number.
    flow_ops: Mutex<()>,
    pub events: broadcast::Sender<FlowEvent>,
    counter: AtomicU64,
    /// Separate from `counter` so request numbers can reset on import without ever
    /// reusing a flow id (ids must stay globally unique; seq need not).
    seq_counter: AtomicU64,
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
            scripts: RwLock::new(ScriptEngine::new()),
            settings: RwLock::new(settings),
            cursors: Mutex::new(RuleCursors::default()),
            history: Mutex::new(History::default()),
            history_ops: Mutex::new(()),
            flow_ops: Mutex::new(()),
            events,
            counter: AtomicU64::new(1),
            seq_counter: AtomicU64::new(1),
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
        self.settings.read().map_or(0, |s| s.response_delay_ms)
    }

    pub fn next_id(&self) -> String {
        format!("f{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    /// The next request number (`Flow::seq`), starting at 1.
    pub fn next_seq(&self) -> u64 {
        self.seq_counter.fetch_add(1, Ordering::Relaxed)
    }

    /// Restart request numbering from 1, so an opened capture is numbered 1..N
    /// rather than continuing the prior session's count.
    pub fn reset_seq(&self) {
        self.seq_counter.store(1, Ordering::Relaxed);
    }

    /// The header-column specs the user has pinned (for `extract_header_columns`).
    pub(crate) fn header_cols(&self) -> Vec<String> {
        self.settings
            .read()
            .map(|s| s.header_columns.clone())
            .unwrap_or_default()
    }

    /// Record a freshly-captured request (response pending) and emit `New`,
    /// preceded by a `Removed` for any flow the insert evicted to honor the cap so
    /// the UI's list stays in sync with the store. A poisoned store lock skips the
    /// whole thing rather than emit a `New` for a row that was never stored.
    #[cfg(test)]
    pub fn record_new(&self, flow: Flow) {
        let _flow_op = self
            .flow_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.record_new_locked(flow);
    }

    /// Production capture path: assign the request number and insert while one
    /// flow-document operation is held. `record_new` remains available for
    /// restoring/test data whose sequence number is already assigned.
    pub fn record_captured(&self, mut flow: Flow) {
        let _flow_op = self
            .flow_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        flow.seq = self.next_seq();
        self.record_new_locked(flow);
    }

    fn record_new_locked(&self, flow: Flow) {
        let cols = self.header_cols();
        let mut summary = flow.summary();
        summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), &cols);
        let Ok(mut store) = self.store.lock() else {
            return;
        };
        let evicted = store.insert(flow);
        if !evicted.is_empty() {
            let _ = self.events.send(FlowEvent::Removed { ids: evicted });
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
        // Complete the ordinary live row immediately. Bytes bodies are
        // ref-counted, so retaining a clone for the history reconciliation
        // below does not copy the payload.
        self.complete_stored_flow(
            id,
            &resp,
            duration_ms,
            ttfb_ms,
            matched_rule.as_deref(),
            &cols,
            false,
        );

        // A user may delete/clear an in-flight row, or undo that deletion before
        // this response arrives. Serialize a retry with those history operations
        // AND update the parked snapshot: a later redo/undo must not replace the
        // completed live row with the pending copy captured at delete time.
        let _history_op = self
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // An undo may have restored the pending snapshot after the optimistic
        // completion above. Only emit a second completion when that actually
        // happened; the normal path remains a single event.
        self.complete_stored_flow(
            id,
            &resp,
            duration_ms,
            ttfb_ms,
            matched_rule.as_deref(),
            &cols,
            true,
        );
        if let Ok(mut history) = self.history.lock() {
            history.complete_flow(id, resp, duration_ms, ttfb_ms, matched_rule);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn complete_stored_flow(
        &self,
        id: &str,
        response: &CapturedResponse,
        duration_ms: u64,
        ttfb_ms: Option<u64>,
        matched_rule: Option<&str>,
        cols: &[String],
        pending_only: bool,
    ) {
        let Ok(mut store) = self.store.lock() else {
            return;
        };
        let should_complete = store
            .get(id)
            .is_some_and(|flow| !pending_only || flow.response.is_none());
        if !should_complete {
            return;
        }
        store.set_response(
            id,
            response.clone(),
            duration_ms,
            ttfb_ms,
            matched_rule.map(str::to_owned),
        );
        let summary = store.get(id).map(|flow| {
            let mut summary = flow.summary();
            summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), cols);
            summary
        });
        if let Some(summary) = summary {
            let _ = self.events.send(FlowEvent::Completed { summary });
        }
    }

    /// Insert an already-complete imported flow and emit it as `Completed`
    /// (the frontend upserts by id, so a single Completed adds the row), preceded
    /// by a `Removed` for any captured flow the insert evicted to honor the cap.
    #[cfg(test)]
    pub fn record_imported(&self, flow: Flow) {
        let _flow_op = self
            .flow_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.record_imported_locked(flow);
    }

    #[cfg(test)]
    fn record_imported_locked(&self, flow: Flow) {
        let cols = self.header_cols();
        let mut summary = flow.summary();
        summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), &cols);
        let Ok(mut store) = self.store.lock() else {
            return;
        };
        let evicted = store.insert(flow);
        if !evicted.is_empty() {
            let _ = self.events.send(FlowEvent::Removed { ids: evicted });
        }
        let _ = self.events.send(FlowEvent::Completed { summary });
    }

    /// Assign fresh ids/request numbers and insert a parsed capture as one
    /// contiguous flow-document operation. `replace` clears the old document
    /// and resets numbering before the first imported row.
    pub fn import_flows(&self, flows: Vec<Flow>, replace: bool) -> Vec<crate::flow::FlowSummary> {
        let _flow_op = self
            .flow_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cols = self.header_cols();
        let Ok(mut store) = self.store.lock() else {
            return Vec::new();
        };
        if replace {
            store.clear();
            let _ = self.events.send(FlowEvent::Cleared);
            self.reset_seq();
        }

        let mut summaries = Vec::with_capacity(flows.len());
        for mut flow in flows {
            flow.id = self.next_id();
            flow.seq = self.next_seq();
            let mut summary = flow.summary();
            summary.extra = extract_header_columns(&flow.request, flow.response.as_ref(), &cols);
            let evicted = store.insert(flow);
            if !evicted.is_empty() {
                let _ = self.events.send(FlowEvent::Removed { ids: evicted });
            }
            let _ = self.events.send(FlowEvent::Completed {
                summary: summary.clone(),
            });
            summaries.push(summary);
        }
        summaries
    }

    /// Set (or clear) a flow's user comment and emit the updated row.
    pub fn set_comment(&self, id: &str, comment: Option<String>) {
        let _history_op = self
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cols = self.header_cols();
        if let Ok(mut store) = self.store.lock() {
            store.set_comment(id, comment.clone());
            let summary = store.get(id).map(|f| {
                let mut s = f.summary();
                s.extra = extract_header_columns(&f.request, f.response.as_ref(), &cols);
                s
            });
            if let Some(summary) = summary {
                let _ = self.events.send(FlowEvent::Completed { summary });
            }
        }
        if let Ok(mut history) = self.history.lock() {
            history.set_flow_comment(id, comment);
        }
    }

    /// Record a flow's public-availability verdict and emit the updated row (the
    /// frontend upserts by id, so the inline icon refreshes live).
    pub fn set_availability(&self, id: &str, availability: crate::flow::Availability) {
        let _history_op = self
            .history_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cols = self.header_cols();
        if let Ok(mut store) = self.store.lock() {
            if store.set_availability(id, availability.clone()) {
                let summary = store.get(id).map(|f| {
                    let mut s = f.summary();
                    s.extra = extract_header_columns(&f.request, f.response.as_ref(), &cols);
                    s
                });
                if let Some(summary) = summary {
                    let _ = self.events.send(FlowEvent::Completed { summary });
                }
            }
        }
        if let Ok(mut history) = self.history.lock() {
            history.set_flow_availability(id, availability);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{Availability, AvailabilityVerdict, CapturedRequest, CapturedResponse, Flow};

    fn req(id: &str) -> CapturedRequest {
        CapturedRequest {
            method: "GET".into(),
            uri: format!("https://h/{id}"),
            scheme: "https".into(),
            host: "h".into(),
            path: format!("/{id}"),
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        }
    }

    fn flow(id: &str) -> Flow {
        Flow {
            id: id.to_string(),
            seq: 0,
            request: req(id),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        }
    }

    fn resp() -> CapturedResponse {
        CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: b"hi".to_vec().into(),
            timestamp_ms: 0,
        }
    }

    fn shared_with(settings: ProxySettings) -> Arc<Shared> {
        Shared::new(100, AutoResponder::example(), settings)
    }

    #[test]
    fn next_id_increments_with_an_f_prefix() {
        let s = shared_with(ProxySettings::default());
        assert_eq!(s.next_id(), "f1");
        assert_eq!(s.next_id(), "f2");
        assert_eq!(s.next_id(), "f3");
    }

    #[test]
    fn next_seq_increments_from_one_and_resets() {
        let s = shared_with(ProxySettings::default());
        assert_eq!(s.next_seq(), 1);
        assert_eq!(s.next_seq(), 2);
        assert_eq!(s.next_seq(), 3);
        // A fresh import restarts numbering at 1 (opening a capture file).
        s.reset_seq();
        assert_eq!(s.next_seq(), 1);
        assert_eq!(s.next_seq(), 2);
    }

    #[test]
    fn nothing_is_bypassed_by_default() {
        let s = shared_with(ProxySettings::default());
        assert!(!s.should_bypass("example.com"));
    }

    #[test]
    fn excluded_hosts_and_their_subdomains_are_bypassed() {
        let s = shared_with(ProxySettings {
            excluded_hosts: vec!["blocked.com".into()],
            ..Default::default()
        });
        assert!(s.should_bypass("blocked.com"));
        assert!(s.should_bypass("api.blocked.com"));
        assert!(!s.should_bypass("allowed.com"));
    }

    #[test]
    fn a_capture_filter_bypasses_everything_outside_it() {
        let s = shared_with(ProxySettings {
            capture_filter: vec!["keep.com".into()],
            ..Default::default()
        });
        assert!(!s.should_bypass("keep.com"));
        assert!(!s.should_bypass("sub.keep.com"));
        assert!(s.should_bypass("other.com"));
    }

    #[test]
    fn response_delay_reflects_settings() {
        let s = shared_with(ProxySettings {
            response_delay_ms: 250,
            ..Default::default()
        });
        assert_eq!(s.response_delay_ms(), 250);
    }

    #[test]
    fn record_new_stores_the_flow_and_emits_new() {
        let s = shared_with(ProxySettings::default());
        let mut rx = s.events.subscribe();
        s.record_new(flow("a"));
        match rx.try_recv() {
            Ok(FlowEvent::New { summary }) => {
                assert_eq!(summary.id, "a");
                assert_eq!(summary.status, None);
            }
            other => panic!("expected New, got {other:?}"),
        }
        assert!(s.store.lock().unwrap().get("a").is_some());
    }

    #[test]
    fn record_new_emits_removed_for_the_flow_it_evicts() {
        let s = Shared::new(1, AutoResponder::example(), ProxySettings::default());
        s.record_new(flow("a"));
        let mut rx = s.events.subscribe();
        // At cap 1, recording "b" evicts "a"; subscribers must get a Removed for "a"
        // so their list stays in sync with the store, then the New for "b".
        s.record_new(flow("b"));
        match rx.try_recv() {
            Ok(FlowEvent::Removed { ids }) => assert_eq!(ids, vec!["a".to_string()]),
            other => panic!("expected Removed for the evicted flow, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(FlowEvent::New { summary }) => assert_eq!(summary.id, "b"),
            other => panic!("expected New for the inserted flow, got {other:?}"),
        }
        let store = s.store.lock().unwrap();
        assert!(
            store.get("a").is_none(),
            "evicted flow is gone from the store"
        );
        assert!(store.get("b").is_some());
    }

    #[test]
    fn record_complete_attaches_the_response_and_emits_completed() {
        let s = shared_with(ProxySettings::default());
        s.record_new(flow("a"));
        let mut rx = s.events.subscribe();
        s.record_complete("a", resp(), 7, Some(3), Some("mock".into()));
        match rx.try_recv() {
            Ok(FlowEvent::Completed { summary }) => {
                assert_eq!(summary.id, "a");
                assert_eq!(summary.status, Some(200));
                assert_eq!(summary.duration_ms, Some(7));
                assert_eq!(summary.ttfb_ms, Some(3));
                assert_eq!(summary.matched_rule.as_deref(), Some("mock"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn completing_an_unknown_flow_emits_nothing() {
        let s = shared_with(ProxySettings::default());
        let mut rx = s.events.subscribe();
        s.record_complete("ghost", resp(), 1, None, None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn record_imported_marks_the_flow_and_emits_completed() {
        let s = shared_with(ProxySettings::default());
        let mut rx = s.events.subscribe();
        let mut f = flow("imp");
        f.imported = true;
        f.response = Some(resp());
        s.record_imported(f);
        match rx.try_recv() {
            Ok(FlowEvent::Completed { summary }) => assert!(summary.imported),
            other => panic!("expected Completed, got {other:?}"),
        }
        assert!(s.store.lock().unwrap().get("imp").unwrap().imported);
    }

    #[test]
    fn set_comment_updates_the_flow_and_emits_completed() {
        let s = shared_with(ProxySettings::default());
        s.record_new(flow("a"));
        let mut rx = s.events.subscribe();
        s.set_comment("a", Some("look here".into()));
        match rx.try_recv() {
            Ok(FlowEvent::Completed { summary }) => {
                assert_eq!(summary.comment.as_deref(), Some("look here"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn commenting_on_an_unknown_flow_emits_nothing() {
        let s = shared_with(ProxySettings::default());
        let mut rx = s.events.subscribe();
        s.set_comment("ghost", Some("x".into()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn set_availability_records_the_verdict_and_emits_completed() {
        let s = shared_with(ProxySettings::default());
        s.record_new(flow("a"));
        let mut rx = s.events.subscribe();
        let avail = Availability {
            verdict: AvailabilityVerdict::Public,
            status: Some(200),
            location: None,
        };
        s.set_availability("a", avail.clone());
        match rx.try_recv() {
            Ok(FlowEvent::Completed { summary }) => assert_eq!(summary.availability, Some(avail)),
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn setting_availability_on_an_unknown_flow_emits_nothing() {
        let s = shared_with(ProxySettings::default());
        let mut rx = s.events.subscribe();
        let avail = Availability {
            verdict: AvailabilityVerdict::Error,
            status: None,
            location: None,
        };
        s.set_availability("ghost", avail);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn concurrent_record_new_never_delivers_removed_before_new() {
        use std::collections::HashSet;
        for _ in 0..20 {
            let s = Shared::new(3, AutoResponder::example(), ProxySettings::default());
            let mut rx = s.events.subscribe();
            let producers: Vec<_> = (0..4)
                .map(|t| {
                    let s = Arc::clone(&s);
                    std::thread::spawn(move || {
                        for i in 0..250 {
                            s.record_new(flow(&format!("t{t}-{i}")));
                        }
                    })
                })
                .collect();
            for p in producers {
                p.join().expect("producer thread");
            }
            let mut live: HashSet<String> = HashSet::new();
            while let Ok(event) = rx.try_recv() {
                match event {
                    FlowEvent::New { summary } => {
                        live.insert(summary.id);
                    }
                    FlowEvent::Removed { ids } => {
                        for id in ids {
                            assert!(
                                live.remove(&id),
                                "Removed {{{id}}} delivered before its New — permanent ghost row"
                            );
                        }
                    }
                    _ => {}
                }
            }
            let stored: HashSet<String> = s.store.lock().unwrap().ids().into_iter().collect();
            assert_eq!(
                live, stored,
                "replaying the event stream must reproduce the store"
            );
        }
    }

    #[test]
    fn replacing_import_is_contiguous_against_live_capture() {
        let shared = Shared::new(500, AutoResponder::example(), ProxySettings::default());
        let barrier = Arc::new(std::sync::Barrier::new(3));

        let importer = {
            let shared = Arc::clone(&shared);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let imported = (0..80)
                    .map(|index| {
                        let mut item = flow(&format!("import-{index}"));
                        item.imported = true;
                        item.response = Some(resp());
                        item
                    })
                    .collect();
                barrier.wait();
                shared.import_flows(imported, true)
            })
        };
        let capturer = {
            let shared = Arc::clone(&shared);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for index in 0..80 {
                    shared.record_captured(flow(&format!("live-{index}")));
                }
            })
        };
        barrier.wait();
        let imported_flows = importer.join().expect("importer");
        capturer.join().expect("capturer");

        assert_eq!(imported_flows.len(), 80);
        let stored = shared.store.lock().expect("store").all_flows();
        assert!(stored.len() >= 80);
        assert!(
            stored[..80].iter().all(|flow| flow.imported),
            "the replacing file must land as one contiguous document prefix"
        );
        assert!(
            stored.windows(2).all(|pair| pair[0].seq < pair[1].seq),
            "store order and request numbers must agree without duplicates"
        );
        assert_eq!(stored[0].seq, 1);
    }
}
