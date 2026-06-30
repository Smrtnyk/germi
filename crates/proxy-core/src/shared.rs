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
            body: vec![],
            timestamp_ms: 0,
        }
    }

    fn flow(id: &str) -> Flow {
        Flow {
            id: id.to_string(),
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
            body: b"hi".to_vec(),
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
        let s = shared_with(ProxySettings { response_delay_ms: 250, ..Default::default() });
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
        let avail =
            Availability { verdict: AvailabilityVerdict::Error, status: None, location: None };
        s.set_availability("ghost", avail);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn get_request_returns_a_clone_for_known_ids_only() {
        let s = shared_with(ProxySettings::default());
        s.record_new(flow("a"));
        let got = s.get_request("a").expect("known id");
        assert_eq!(got.path, "/a");
        assert!(s.get_request("ghost").is_none());
    }
}
