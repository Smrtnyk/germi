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

    /// Change the retention cap, evicting the oldest captured flows if it shrank.
    /// Returns the evicted ids so the caller can emit a matching `Removed` and keep
    /// the UI's flow list in sync (imported flows are never evicted).
    pub fn set_max(&mut self, max: usize) -> Vec<String> {
        self.max = max.max(1);
        let mut evicted = Vec::new();
        while self.order.len() > self.max {
            match self.evict_oldest() {
                Some(id) => evicted.push(id),
                None => break,
            }
        }
        evicted
    }

    /// Insert a freshly-captured flow (response may still be pending). Returns the
    /// ids evicted to honor the cap (usually none) so the caller can emit a
    /// matching `Removed` and keep the UI's flow list in sync with the store.
    pub fn insert(&mut self, flow: Flow) -> Vec<String> {
        let mut evicted = Vec::new();
        if self.flows.insert(flow.id.clone(), flow.clone()).is_none() {
            self.order.push_back(flow.id);
            while self.order.len() > self.max {
                match self.evict_oldest() {
                    Some(id) => evicted.push(id),
                    None => break,
                }
            }
        }
        evicted
    }

    /// Evict one flow to honor the cap, returning its id (or `None` when nothing is
    /// evictable). **Imported flows are never evicted** — they are the file-loaded
    /// reference the user replays against (issue #49), so the cap only ever trims
    /// live-captured traffic. Among captured flows, prefer the oldest *completed*
    /// one so an in-flight flow isn't dropped before its response is recorded (which
    /// would strand a forever-"pending" row and silently lose the response); fall
    /// back to the oldest captured flow only when every captured flow is still
    /// in-flight. `None` when only imported flows remain (a large import is kept
    /// whole), which also lets the `insert` / `set_max` loops terminate.
    fn evict_oldest(&mut self) -> Option<String> {
        let victim = self
            .order
            .iter()
            .find(|id| {
                self.flows
                    .get(*id)
                    .is_some_and(|f| !f.imported && f.response.is_some())
            })
            .or_else(|| {
                self.order
                    .iter()
                    .find(|id| self.flows.get(*id).is_some_and(|f| !f.imported))
            })
            .cloned();
        if let Some(id) = &victim {
            self.flows.remove(id);
            self.order.retain(|x| x != id);
        }
        victim
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

    /// Record a flow's public-availability verdict. Returns whether the flow
    /// existed (so callers can skip emitting an update for an evicted id).
    pub fn set_availability(&mut self, id: &str, availability: crate::flow::Availability) -> bool {
        if let Some(flow) = self.flows.get_mut(id) {
            flow.availability = Some(availability);
            true
        } else {
            false
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

    /// Flow ids in capture order for which `keep` returns true. Used to target a
    /// subset for bulk removal (e.g. every non-imported flow — issue #49).
    pub fn ids_where(&self, keep: impl Fn(&Flow) -> bool) -> Vec<String> {
        self.order
            .iter()
            .filter(|id| self.flows.get(id.as_str()).is_some_and(&keep))
            .cloned()
            .collect()
    }

    pub fn clear(&mut self) {
        self.flows.clear();
        self.order.clear();
    }

    /// Remove the given flows by id, preserving the capture order of the rest.
    /// Returns how many of the ids were actually present (so callers can skip
    /// emitting an event when nothing changed). Unknown ids are ignored.
    pub fn remove(&mut self, ids: &[String]) -> usize {
        if ids.is_empty() {
            return 0;
        }
        let drop: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let before = self.order.len();
        self.order.retain(|id| !drop.contains(id.as_str()));
        self.flows.retain(|id, _| !drop.contains(id.as_str()));
        before - self.order.len()
    }

    /// Like `remove`, but returns each removed flow paired with its original
    /// position in capture order (ascending), so the removal can be reversed
    /// with `restore`. Unknown ids are ignored.
    pub fn remove_capturing(&mut self, ids: &[String]) -> Vec<(usize, Flow)> {
        if ids.is_empty() {
            return Vec::new();
        }
        let drop: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let captured: Vec<(usize, Flow)> = self
            .order
            .iter()
            .enumerate()
            .filter(|(_, id)| drop.contains(id.as_str()))
            .filter_map(|(index, id)| self.flows.get(id).map(|flow| (index, flow.clone())))
            .collect();
        self.order.retain(|id| !drop.contains(id.as_str()));
        self.flows.retain(|id, _| !drop.contains(id.as_str()));
        captured
    }

    /// Re-insert flows removed by `remove_capturing` (or a cleared snapshot),
    /// restoring capture order. `items` must be in ascending-index order; an
    /// index past the current end clamps to the end, and an id that is somehow
    /// already present is skipped (so undo can never duplicate a row). Restoring
    /// may push the store above its retention cap; the next insert trims it.
    pub fn restore(&mut self, items: Vec<(usize, Flow)>) {
        for (index, flow) in items {
            if self.flows.contains_key(&flow.id) {
                continue;
            }
            let at = index.min(self.order.len());
            self.order.insert(at, flow.id.clone());
            self.flows.insert(flow.id.clone(), flow);
        }
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
            seq: 0,
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
            availability: None,
            imported: false,
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
    fn remove_drops_selected_and_preserves_order() {
        let mut store = FlowStore::new(10);
        for id in ["a", "b", "c", "d"] {
            store.insert(flow(id));
        }
        // "zzz" was never inserted — it must be ignored, not counted.
        let removed = store.remove(&["b".to_string(), "d".to_string(), "zzz".to_string()]);
        assert_eq!(removed, 2, "only the two present ids count as removed");
        assert_eq!(
            store.ids(),
            vec!["a".to_string(), "c".to_string()],
            "survivors keep their capture order"
        );
        assert!(store.get("b").is_none());
        assert!(store.get("d").is_none());
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn remove_empty_is_a_noop() {
        let mut store = FlowStore::new(10);
        store.insert(flow("a"));
        assert_eq!(store.remove(&[]), 0);
        assert_eq!(store.len(), 1);
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

    #[test]
    fn remove_capturing_then_restore_round_trips_capture_order() {
        let mut store = FlowStore::new(10);
        for id in ["a", "b", "c", "d"] {
            store.insert(flow(id));
        }
        let captured = store.remove_capturing(&["b".to_string(), "d".to_string()]);
        assert_eq!(
            captured.iter().map(|(i, f)| (*i, f.id.clone())).collect::<Vec<_>>(),
            vec![(1, "b".to_string()), (3, "d".to_string())],
            "removed flows carry their original capture positions, ascending"
        );
        assert_eq!(store.ids(), vec!["a".to_string(), "c".to_string()]);

        store.restore(captured);
        assert_eq!(
            store.ids(),
            ["a", "b", "c", "d"].map(str::to_string).to_vec(),
            "restore rebuilds the original capture order exactly"
        );
    }

    #[test]
    fn ids_where_filters_in_capture_order() {
        let mut store = FlowStore::new(10);
        for id in ["a", "b", "c"] {
            let mut f = flow(id);
            f.imported = id == "b"; // only "b" is imported
            store.insert(f);
        }
        assert_eq!(
            store.ids_where(|f| !f.imported),
            vec!["a".to_string(), "c".to_string()],
            "captured (non-imported) ids keep capture order"
        );
        assert_eq!(store.ids_where(|f| f.imported), vec!["b".to_string()]);
    }

    #[test]
    fn restore_skips_ids_already_present() {
        let mut store = FlowStore::new(10);
        store.insert(flow("a"));
        store.insert(flow("b"));
        // "a" is still present — restoring a stale capture of it must not dup the row.
        store.restore(vec![(0, flow("a"))]);
        assert_eq!(store.ids(), vec!["a".to_string(), "b".to_string()]);
    }

    fn completed(id: &str) -> Flow {
        let mut f = flow(id);
        f.response = Some(response());
        f
    }

    fn imported(id: &str) -> Flow {
        let mut f = completed(id);
        f.imported = true;
        f
    }

    #[test]
    fn insert_returns_the_ids_it_evicted() {
        let mut store = FlowStore::new(2);
        assert!(store.insert(completed("a")).is_empty(), "under cap: nothing evicted");
        assert!(store.insert(completed("b")).is_empty());
        // At cap 2, inserting "c" evicts the oldest completed flow and reports it.
        assert_eq!(store.insert(completed("c")), vec!["a".to_string()]);
        assert_eq!(store.ids(), vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn eviction_never_drops_imported_flows() {
        let mut store = FlowStore::new(2);
        store.insert(imported("imp")); // the file-loaded reference (issue #49)
        store.insert(completed("a"));
        // At cap, further captures evict the captured flows, never the imported one.
        assert_eq!(store.insert(completed("b")), vec!["a".to_string()]);
        assert_eq!(store.insert(completed("c")), vec!["b".to_string()]);
        assert!(store.get("imp").is_some(), "imported flow is protected from cap eviction");
        assert_eq!(store.ids(), vec!["imp".to_string(), "c".to_string()]);
    }

    #[test]
    fn imported_flows_beyond_cap_are_all_kept() {
        // A large import can exceed the cap; imported flows are never evicted, so the
        // store keeps them all and the eviction loop must still terminate (no spin).
        let mut store = FlowStore::new(1);
        for id in ["a", "b", "c"] {
            assert!(store.insert(imported(id)).is_empty(), "imported inserts evict nothing");
        }
        assert_eq!(store.len(), 3, "all imported flows are retained despite cap 1");
    }

    #[test]
    fn set_max_evicts_captured_reports_ids_and_keeps_imported() {
        let mut store = FlowStore::new(10);
        store.insert(imported("imp"));
        for id in ["a", "b", "c"] {
            store.insert(completed(id));
        }
        // Shrinking the cap evicts only captured flows (oldest first) and reports the
        // ids so the caller can emit a matching `Removed`.
        assert_eq!(store.set_max(2), vec!["a".to_string(), "b".to_string()]);
        assert!(store.get("imp").is_some(), "imported reference survives a cap shrink");
        assert_eq!(store.ids(), vec!["imp".to_string(), "c".to_string()]);
    }
}
