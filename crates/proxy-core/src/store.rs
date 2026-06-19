//! Bounded, insertion-ordered in-memory store of captured flows.
//!
//! Full bodies live here (in Rust), never on the IPC firehose. The UI fetches a
//! flow's detail on demand when a row is selected. Oldest flows are evicted once
//! `max` is reached so a long capture session can't grow unbounded.
//!
//! Phase 2 swaps this for a SQLite-backed store (rusqlite, WAL) behind the same
//! API for persistence across restarts.

use std::collections::{HashMap, VecDeque};

use crate::flow::{CapturedResponse, Flow, FlowDetail, FlowSummary};

pub struct FlowStore {
    flows: HashMap<String, Flow>,
    order: VecDeque<String>,
    max: usize,
}

impl FlowStore {
    pub fn new(max: usize) -> Self {
        Self {
            flows: HashMap::new(),
            order: VecDeque::new(),
            max: max.max(1),
        }
    }

    /// Change the retention cap, evicting the oldest flows if it shrank.
    pub fn set_max(&mut self, max: usize) {
        self.max = max.max(1);
        while self.order.len() > self.max {
            self.evict_oldest();
        }
    }

    /// Insert a freshly-captured flow (response may still be pending).
    pub fn insert(&mut self, flow: Flow) {
        if self.flows.insert(flow.id.clone(), flow.clone()).is_none() {
            self.order.push_back(flow.id);
            while self.order.len() > self.max {
                self.evict_oldest();
            }
        }
    }

    /// Evict one flow to honor the cap. Prefer the oldest *completed* flow so an
    /// in-flight flow isn't dropped before its response is recorded (which would
    /// strand a forever-"pending" row and silently lose the response). Fall back
    /// to the absolute oldest only when every retained flow is still in-flight.
    fn evict_oldest(&mut self) {
        let victim = self
            .order
            .iter()
            .find(|id| self.flows.get(*id).is_some_and(|f| f.response.is_some()))
            .or_else(|| self.order.front())
            .cloned();
        if let Some(id) = victim {
            self.flows.remove(&id);
            self.order.retain(|x| x != &id);
        }
    }

    /// Attach the response (and timing / matched rule) to an existing flow.
    pub fn set_response(
        &mut self,
        id: &str,
        resp: CapturedResponse,
        duration_ms: u64,
        ttfb_ms: Option<u64>,
        matched_rule: Option<String>,
    ) {
        if let Some(flow) = self.flows.get_mut(id) {
            flow.response = Some(resp);
            flow.duration_ms = Some(duration_ms);
            flow.ttfb_ms = ttfb_ms;
            if matched_rule.is_some() {
                flow.matched_rule = matched_rule;
            }
        }
    }

    /// Set or clear a flow's user comment.
    pub fn set_comment(&mut self, id: &str, comment: Option<String>) {
        if let Some(flow) = self.flows.get_mut(id) {
            flow.comment = comment;
        }
    }

    pub fn get(&self, id: &str) -> Option<&Flow> {
        self.flows.get(id)
    }

    pub fn detail(&self, id: &str, decode: bool, full: bool) -> Option<FlowDetail> {
        self.flows.get(id).map(|f| f.detail(decode, full))
    }

    /// All summaries in capture order (oldest first), with pinned header columns.
    pub fn summaries(&self, header_cols: &[String]) -> Vec<FlowSummary> {
        self.order
            .iter()
            .filter_map(|id| self.flows.get(id))
            .map(|f| {
                let mut s = f.summary();
                s.extra =
                    crate::flow::extract_header_columns(&f.request, f.response.as_ref(), header_cols);
                s
            })
            .collect()
    }

    /// Full clones of every flow in capture order (for session export).
    pub fn all_flows(&self) -> Vec<Flow> {
        self.order
            .iter()
            .filter_map(|id| self.flows.get(id).cloned())
            .collect()
    }

    /// Flow ids in capture order (for body search over all flows).
    pub fn ids(&self) -> Vec<String> {
        self.order.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.flows.clear();
        self.order.clear();
    }

    #[allow(dead_code)] // used by the Tauri layer's status bar
    pub fn len(&self) -> usize {
        self.order.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::CapturedRequest;

    fn flow(id: &str) -> Flow {
        Flow {
            id: id.to_string(),
            request: CapturedRequest {
                method: "GET".into(),
                uri: format!("https://h/{id}"),
                scheme: "https".into(),
                host: "h".into(),
                path: format!("/{id}"),
                version: "HTTP/1.1".into(),
                headers: vec![],
                body: vec![],
                timestamp_ms: 0,
            },
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
        }
    }

    fn response() -> CapturedResponse {
        CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![],
            body: vec![],
            timestamp_ms: 0,
        }
    }

    #[test]
    fn eviction_keeps_in_flight_over_completed() {
        let mut store = FlowStore::new(2);
        store.insert(flow("a")); // in-flight (oldest)
        store.insert(flow("b"));
        store.set_response("b", response(), 1, None, None); // completed
        // Inserting a third flow at cap 2 must evict the completed "b", not the
        // still-pending oldest "a" whose response hasn't arrived yet.
        store.insert(flow("c"));
        assert!(store.get("a").is_some(), "in-flight flow must be retained");
        assert!(store.get("b").is_none(), "the completed flow is evicted instead");
        assert!(store.get("c").is_some());
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn eviction_falls_back_to_oldest_when_all_in_flight() {
        let mut store = FlowStore::new(2);
        store.insert(flow("a"));
        store.insert(flow("b"));
        store.insert(flow("c")); // all in-flight → evict absolute oldest "a"
        assert!(store.get("a").is_none());
        assert!(store.get("b").is_some());
        assert!(store.get("c").is_some());
        assert_eq!(store.len(), 2);
    }
}
