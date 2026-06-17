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

    /// Insert a freshly-captured flow (response may still be pending).
    pub fn insert(&mut self, flow: Flow) {
        if self.flows.insert(flow.id.clone(), flow.clone()).is_none() {
            self.order.push_back(flow.id);
            while self.order.len() > self.max {
                if let Some(old) = self.order.pop_front() {
                    self.flows.remove(&old);
                }
            }
        }
    }

    /// Attach the response (and timing / matched rule) to an existing flow.
    pub fn set_response(
        &mut self,
        id: &str,
        resp: CapturedResponse,
        duration_ms: u64,
        matched_rule: Option<String>,
    ) {
        if let Some(flow) = self.flows.get_mut(id) {
            flow.response = Some(resp);
            flow.duration_ms = Some(duration_ms);
            if matched_rule.is_some() {
                flow.matched_rule = matched_rule;
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&Flow> {
        self.flows.get(id)
    }

    pub fn detail(&self, id: &str, decode: bool, full: bool) -> Option<FlowDetail> {
        self.flows.get(id).map(|f| f.detail(decode, full))
    }

    /// All summaries in capture order (oldest first).
    pub fn summaries(&self) -> Vec<FlowSummary> {
        self.order
            .iter()
            .filter_map(|id| self.flows.get(id))
            .map(|f| f.summary())
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
