//! In-memory undo/redo timeline for the data the user authors: the mock document
//! (`AutoResponder`) and traffic curation (pruned / cleared flows).
//!
//! This is a **pure data structure** — it stores reversible entries and decides
//! coalescing and eviction; it never touches live proxy state. `ProxyController`
//! owns the application of an entry to the store / autoresponder. Keeping the two
//! apart is what makes the policy here (what merges, what gets evicted, what the
//! UI sees) unit-testable without a running proxy.
//!
//! Entries are **bidirectional**: undo and redo apply opposite "sides" of the
//! same op, so no separate inverse is ever stored. Coalescing is **clock-free** —
//! it merges consecutive entries that share a frontend-supplied key, so typing a
//! rule URL lands as one undo step instead of one-per-keystroke.

use serde::{Deserialize, Serialize};

use crate::flow::{now_ms, Flow};
use crate::rules::{Action, AutoResponder};

/// Entries retained before the oldest are dropped.
const DEFAULT_DEPTH_CAP: usize = 200;
/// Soft ceiling on retained payload bytes (sum of per-entry estimates).
const DEFAULT_BYTE_CAP: usize = 256 * 1024 * 1024;

/// Which domain an entry belongs to — drives the UI icon, and tells the caller
/// whether applying it changed the autoresponder (so it must re-persist).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKind {
    Mock,
    Traffic,
}

/// Metadata the frontend attaches to a mock mutation: a human label and an
/// optional coalescing key. Consecutive mock entries sharing a key merge into
/// one (the original `before` is kept, the latest `after` wins). Crosses the IPC
/// boundary, so it deserializes from the camelCase the webview sends.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTag {
    pub label: String,
    #[serde(default)]
    pub coalesce_key: Option<String>,
}

impl HistoryTag {
    pub fn new(label: impl Into<String>, coalesce_key: Option<String>) -> Self {
        Self {
            label: label.into(),
            coalesce_key,
        }
    }
}

/// A reversible operation captured in the timeline.
#[derive(Clone, Debug)]
pub enum HistoryOp {
    /// A mock-document change as before/after snapshots of the whole responder.
    Mock {
        before: AutoResponder,
        after: AutoResponder,
    },
    /// Flows pruned from the store, each with its original capture position.
    FlowsRemoved { items: Vec<(usize, Flow)> },
    /// The whole store cleared (snapshot in capture order).
    FlowsCleared { flows: Vec<Flow> },
}

impl HistoryOp {
    fn kind(&self) -> HistoryKind {
        match self {
            HistoryOp::Mock { .. } => HistoryKind::Mock,
            HistoryOp::FlowsRemoved { .. } | HistoryOp::FlowsCleared { .. } => HistoryKind::Traffic,
        }
    }

    /// Rough payload size, for the byte budget. Bodies dominate; everything else
    /// is a small constant per entity.
    fn size(&self) -> usize {
        match self {
            HistoryOp::Mock { before, after } => ar_size(before) + ar_size(after),
            HistoryOp::FlowsRemoved { items } => items.iter().map(|(_, f)| flow_size(f)).sum(),
            HistoryOp::FlowsCleared { flows } => flows.iter().map(flow_size).sum(),
        }
    }
}

fn ar_size(ar: &AutoResponder) -> usize {
    ar.scenarios
        .iter()
        .flat_map(|s| &s.rules)
        .map(|r| match &r.action {
            Action::Respond { body, .. } => body.len() + 64,
            _ => 64,
        })
        .sum::<usize>()
        + 64
}

fn flow_size(f: &Flow) -> usize {
    f.request.body.len() + f.response.as_ref().map_or(0, |r| r.body.len()) + 256
}

/// One timeline entry. `id` is stable across coalescing merges so the UI can
/// jump to it.
#[derive(Clone, Debug)]
pub struct HistoryEntry {
    pub id: u64,
    pub op: HistoryOp,
    pub label: String,
    pub kind: HistoryKind,
    pub timestamp_ms: u64,
    pub bytes: usize,
}

impl HistoryEntry {
    fn to_view(&self, undone: bool) -> HistoryEntryView {
        HistoryEntryView {
            id: self.id,
            label: self.label.clone(),
            kind: self.kind,
            timestamp_ms: self.timestamp_ms,
            undone,
        }
    }
}

/// Lightweight per-entry row for the history panel (no payloads).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryView {
    pub id: u64,
    pub label: String,
    pub kind: HistoryKind,
    pub timestamp_ms: u64,
    /// True when this entry sits in the redo stack (a future state).
    pub undone: bool,
}

/// The whole timeline, as the frontend renders it: applied entries oldest→newest,
/// then undone (future) entries in chronological order.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    pub entries: Vec<HistoryEntryView>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Undo/redo stacks plus the coalescing cursor and eviction caps.
pub struct History {
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    /// The key currently open for coalescing — only a record with this exact key
    /// merges into the top entry. Any undo/redo/clear or a differently-keyed (or
    /// unkeyed) record seals it.
    open_key: Option<String>,
    next_id: u64,
    depth_cap: usize,
    byte_cap: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::with_caps(DEFAULT_DEPTH_CAP, DEFAULT_BYTE_CAP)
    }
}

impl History {
    pub fn with_caps(depth_cap: usize, byte_cap: usize) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            open_key: None,
            next_id: 1,
            depth_cap: depth_cap.max(1),
            byte_cap,
        }
    }

    /// Record a new user action. Clears the redo stack (a new action invalidates
    /// the future), then either merges into the open entry or pushes a new one.
    pub fn record(&mut self, op: HistoryOp, tag: HistoryTag) {
        self.redo.clear();
        let ts = now_ms();
        let bytes = op.size();
        let kind = op.kind();
        let key = tag.coalesce_key;

        let can_merge = matches!((&key, &self.open_key), (Some(k), Some(open)) if k == open)
            && matches!(self.undo.last().map(|e| &e.op), Some(HistoryOp::Mock { .. }))
            && matches!(&op, HistoryOp::Mock { .. });

        if can_merge {
            let top = self.undo.last_mut().expect("open_key implies a top entry");
            if let (HistoryOp::Mock { after: slot, .. }, HistoryOp::Mock { after, .. }) =
                (&mut top.op, op)
            {
                *slot = after;
            }
            top.label = tag.label;
            top.bytes = bytes;
            top.timestamp_ms = ts;
            self.evict();
            return;
        }

        let entry = HistoryEntry {
            id: self.next_id,
            op,
            label: tag.label,
            kind,
            timestamp_ms: ts,
            bytes,
        };
        self.next_id += 1;
        self.undo.push(entry);
        self.open_key = key;
        self.evict();
    }

    /// Pop the newest applied entry for undoing. Seals coalescing.
    pub fn take_undo(&mut self) -> Option<HistoryEntry> {
        self.open_key = None;
        self.undo.pop()
    }

    /// Pop the next undone entry for redoing. Seals coalescing.
    pub fn take_redo(&mut self) -> Option<HistoryEntry> {
        self.open_key = None;
        self.redo.pop()
    }

    /// Park an entry on the redo stack after it was undone.
    pub fn stash_redo(&mut self, entry: HistoryEntry) {
        self.redo.push(entry);
    }

    /// Return an entry to the applied stack after it was redone. Does not
    /// coalesce or re-evict (the total entry count is unchanged).
    pub fn stash_undo(&mut self, entry: HistoryEntry) {
        self.undo.push(entry);
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.open_key = None;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo_top_id(&self) -> Option<u64> {
        self.undo.last().map(|e| e.id)
    }

    pub fn undo_contains(&self, id: u64) -> bool {
        self.undo.iter().any(|e| e.id == id)
    }

    pub fn redo_contains(&self, id: u64) -> bool {
        self.redo.iter().any(|e| e.id == id)
    }

    pub fn view(&self) -> HistoryView {
        let mut entries: Vec<HistoryEntryView> =
            self.undo.iter().map(|e| e.to_view(false)).collect();
        // Redo stack is LIFO (top = next to reapply); reverse it so the panel
        // reads in chronological order after the current position.
        entries.extend(self.redo.iter().rev().map(|e| e.to_view(true)));
        HistoryView {
            entries,
            can_undo: self.can_undo(),
            can_redo: self.can_redo(),
        }
    }

    fn evict(&mut self) {
        while self.undo.len() > self.depth_cap {
            self.undo.remove(0);
        }
        while self.undo.len() > 1 && self.total_bytes() > self.byte_cap {
            self.undo.remove(0);
        }
    }

    fn total_bytes(&self) -> usize {
        self.undo
            .iter()
            .chain(&self.redo)
            .map(|e| e.bytes)
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ar(active: Option<&str>) -> AutoResponder {
        AutoResponder {
            scenarios: Vec::new(),
            active_scenario_id: active.map(str::to_string),
            general_active: true,
        }
    }

    fn mock(before: Option<&str>, after: Option<&str>) -> HistoryOp {
        HistoryOp::Mock {
            before: ar(before),
            after: ar(after),
        }
    }

    fn after_of(op: &HistoryOp) -> Option<String> {
        match op {
            HistoryOp::Mock { after, .. } => after.active_scenario_id.clone(),
            _ => None,
        }
    }

    #[test]
    fn discrete_entry_does_not_merge_into_a_coalesced_run() {
        // Mirrors "type in a rule (coalesced) then click Format (discrete)": the
        // no-key Format commit must land as its own second entry, not fold into
        // the rule-edit run — so one undo reverts only the format.
        let mut h = History::default();
        let edit = Some("rule:r1".to_string());
        h.record(mock(Some("base"), Some("typed1")), HistoryTag::new("Edit rule", edit.clone()));
        h.record(mock(Some("typed1"), Some("typed2")), HistoryTag::new("Edit rule", edit));
        assert_eq!(h.undo.len(), 1, "the typing coalesces into one entry");

        h.record(mock(Some("typed2"), Some("formatted")), HistoryTag::new("Format body", None));
        assert_eq!(h.undo.len(), 2, "a no-key commit never folds into the coalesced edit run");
        assert_eq!(h.undo[1].label, "Format body");
        assert_eq!(
            after_of(&h.undo[0].op).as_deref(),
            Some("typed2"),
            "the edit run keeps its latest pre-format state, revealed by a second undo"
        );
    }

    #[test]
    fn same_key_coalesces_into_one_entry_keeping_first_before() {
        let mut h = History::default();
        let key = Some("edit:r1:name".to_string());
        h.record(mock(Some("base"), Some("a")), HistoryTag::new("edit", key.clone()));
        h.record(mock(Some("a"), Some("ab")), HistoryTag::new("edit", key.clone()));
        h.record(mock(Some("ab"), Some("abc")), HistoryTag::new("edit", key));

        assert_eq!(h.undo.len(), 1, "three keyed edits collapse to one entry");
        let HistoryOp::Mock { before, .. } = &h.undo[0].op else {
            panic!("expected a mock op");
        };
        assert_eq!(before.active_scenario_id.as_deref(), Some("base"), "first before is kept");
        assert_eq!(after_of(&h.undo[0].op).as_deref(), Some("abc"), "latest after wins");
    }

    #[test]
    fn different_key_starts_a_new_entry() {
        let mut h = History::default();
        h.record(mock(None, Some("a")), HistoryTag::new("a", Some("k1".into())));
        h.record(mock(Some("a"), Some("b")), HistoryTag::new("b", Some("k2".into())));
        assert_eq!(h.undo.len(), 2);
    }

    #[test]
    fn unkeyed_entries_never_coalesce() {
        let mut h = History::default();
        h.record(mock(None, Some("a")), HistoryTag::new("a", None));
        h.record(mock(Some("a"), Some("b")), HistoryTag::new("b", None));
        assert_eq!(h.undo.len(), 2, "no key means each action is discrete");
    }

    #[test]
    fn undo_between_same_keyed_edits_seals_coalescing() {
        let mut h = History::default();
        let key = Some("edit:r1:name".to_string());
        h.record(mock(None, Some("a")), HistoryTag::new("edit", key.clone()));
        let _ = h.take_undo(); // an undo in the middle seals the open key
        h.stash_redo(HistoryEntry {
            id: 999,
            op: mock(None, Some("a")),
            label: "x".into(),
            kind: HistoryKind::Mock,
            timestamp_ms: 0,
            bytes: 0,
        });
        h.record(mock(None, Some("a")), HistoryTag::new("edit", key));
        assert_eq!(h.undo.len(), 1);
        assert!(h.open_key.is_some(), "the fresh record opens a new coalescing window");
    }

    #[test]
    fn recording_clears_redo() {
        let mut h = History::default();
        h.record(mock(None, Some("a")), HistoryTag::new("a", None));
        let e = h.take_undo().expect("undo");
        h.stash_redo(e);
        assert!(h.can_redo());
        h.record(mock(None, Some("b")), HistoryTag::new("b", None));
        assert!(!h.can_redo(), "a new action invalidates the redo stack");
    }

    #[test]
    fn depth_cap_evicts_oldest() {
        let mut h = History::with_caps(3, DEFAULT_BYTE_CAP);
        for i in 0..5 {
            h.record(mock(None, Some(&format!("s{i}"))), HistoryTag::new("e", None));
        }
        assert_eq!(h.undo.len(), 3, "capped at depth 3");
        assert_eq!(after_of(&h.undo[0].op).as_deref(), Some("s2"), "two oldest evicted");
    }

    #[test]
    fn view_orders_applied_then_future_with_flags() {
        let mut h = History::default();
        h.record(mock(None, Some("a")), HistoryTag::new("A", None));
        h.record(mock(Some("a"), Some("b")), HistoryTag::new("B", None));
        h.record(mock(Some("b"), Some("c")), HistoryTag::new("C", None));
        // Undo two → redo stack holds C then B (B on top).
        let c = h.take_undo().unwrap();
        h.stash_redo(c);
        let b = h.take_undo().unwrap();
        h.stash_redo(b);

        let view = h.view();
        let labels: Vec<(&str, bool)> = view
            .entries
            .iter()
            .map(|e| (e.label.as_str(), e.undone))
            .collect();
        assert_eq!(
            labels,
            vec![("A", false), ("B", true), ("C", true)],
            "applied (A) first, then future B, C in chronological order"
        );
        assert!(view.can_undo && view.can_redo);
    }

    #[test]
    fn ids_are_stable_across_coalescing() {
        let mut h = History::default();
        let key = Some("k".to_string());
        h.record(mock(None, Some("a")), HistoryTag::new("e", key.clone()));
        let first_id = h.undo[0].id;
        h.record(mock(Some("a"), Some("b")), HistoryTag::new("e", key));
        assert_eq!(h.undo[0].id, first_id, "merging keeps the entry id stable");
    }
}
