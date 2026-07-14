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

use serde::Deserialize;

use crate::flow::{Availability, CapturedResponse, Flow};
use crate::rules::{Action, AutoResponder};

/// Entries retained before the oldest are dropped.
const DEFAULT_DEPTH_CAP: usize = 200;
/// Soft ceiling on retained payload bytes (sum of per-entry estimates).
const DEFAULT_BYTE_CAP: usize = 256 * 1024 * 1024;

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
    /// Rough payload size, for the byte budget. Bodies dominate; everything else
    /// is a small constant per entity.
    fn size(&self) -> usize {
        match self {
            HistoryOp::Mock { before, after } => ar_size(before).saturating_add(ar_size(after)),
            HistoryOp::FlowsRemoved { items } => items
                .iter()
                .fold(0, |total, (_, flow)| total.saturating_add(flow_size(flow))),
            HistoryOp::FlowsCleared { flows } => flows
                .iter()
                .fold(0, |total, flow| total.saturating_add(flow_size(flow))),
        }
    }
}

fn ar_size(ar: &AutoResponder) -> usize {
    ar.scenarios.iter().fold(64, |total, scenario| {
        let scenario_size = scenario.rules.iter().fold(
            scenario.id.len().saturating_add(scenario.name.len()),
            |rules_total, rule| rules_total.saturating_add(rule_size(rule)),
        );
        total.saturating_add(scenario_size)
    })
}

fn flow_size(f: &Flow) -> usize {
    let request = f
        .request
        .method
        .len()
        .saturating_add(f.request.uri.len())
        .saturating_add(f.request.scheme.len())
        .saturating_add(f.request.host.len())
        .saturating_add(f.request.path.len())
        .saturating_add(f.request.version.len())
        .saturating_add(header_pairs_size(&f.request.headers))
        .saturating_add(f.request.body.len());
    let response = f.response.as_ref().map_or(0, |response| {
        response
            .version
            .len()
            .saturating_add(header_pairs_size(&response.headers))
            .saturating_add(response.body.len())
    });
    256usize
        .saturating_add(f.id.len())
        .saturating_add(request)
        .saturating_add(response)
        .saturating_add(f.matched_rule.as_ref().map_or(0, String::len))
        .saturating_add(f.comment.as_ref().map_or(0, String::len))
}

fn rule_size(rule: &crate::rules::Rule) -> usize {
    let matcher = rule
        .id
        .len()
        .saturating_add(rule.matcher.url.len())
        .saturating_add(rule.matcher.method.as_ref().map_or(0, String::len));
    let action = match &rule.action {
        Action::Respond {
            headers,
            body,
            body_base64,
            content_type,
            content_encoding,
            ..
        } => header_pairs_size(headers)
            .saturating_add(body.len())
            .saturating_add(body_base64.as_ref().map_or(0, String::len))
            .saturating_add(content_type.as_ref().map_or(0, String::len))
            .saturating_add(content_encoding.as_ref().map_or(0, String::len)),
        Action::MapLocal { path, .. } => path.len(),
        Action::MapRemote { url } => url.len(),
        Action::SetRequestHeader { name, value } | Action::SetResponseHeader { name, value } => {
            name.len().saturating_add(value.len())
        }
        Action::RewriteResponseBody { find, replace, .. } => {
            find.len().saturating_add(replace.len())
        }
        Action::Block | Action::SetStatus { .. } | Action::Cors => 0,
    };
    64usize.saturating_add(matcher).saturating_add(action)
}

fn header_pairs_size(headers: &[(String, String)]) -> usize {
    headers.iter().fold(0, |total, (name, value)| {
        total.saturating_add(name.len()).saturating_add(value.len())
    })
}

/// One timeline entry. `id` is stable across coalescing merges so a caller can
/// jump to it.
#[derive(Clone, Debug)]
pub struct HistoryEntry {
    pub id: u64,
    pub op: HistoryOp,
    pub bytes: usize,
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
        let bytes = op.size();
        let key = tag.coalesce_key;

        let can_merge = matches!((&key, &self.open_key), (Some(k), Some(open)) if k == open)
            && matches!(
                self.undo.last().map(|e| &e.op),
                Some(HistoryOp::Mock { .. })
            )
            && matches!(&op, HistoryOp::Mock { .. });

        if can_merge {
            let top = self.undo.last_mut().expect("open_key implies a top entry");
            if let (HistoryOp::Mock { after: slot, .. }, HistoryOp::Mock { after, .. }) =
                (&mut top.op, op)
            {
                *slot = after;
            }
            top.bytes = top.op.size();
            self.evict();
            return;
        }

        let entry = HistoryEntry {
            id: self.next_id,
            op,
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

    /// A replacing capture starts a new traffic document. Retain authored mock
    /// edits, but discard flow entries that could resurrect the previous file.
    pub fn discard_flow_entries(&mut self) {
        self.undo
            .retain(|entry| matches!(entry.op, HistoryOp::Mock { .. }));
        self.redo
            .retain(|entry| matches!(entry.op, HistoryOp::Mock { .. }));
        self.open_key = None;
    }

    /// Attach a late response to a flow currently parked in a delete/clear undo
    /// snapshot. A user can remove an in-flight row before its upstream response
    /// arrives; retaining the completion here prevents a later undo from
    /// resurrecting that request as permanently pending.
    pub fn complete_flow(
        &mut self,
        id: &str,
        response: CapturedResponse,
        duration_ms: u64,
        ttfb_ms: Option<u64>,
        matched_rule: Option<String>,
    ) -> bool {
        let mut found = false;
        for entry in self.undo.iter_mut().chain(self.redo.iter_mut()) {
            let changed = if let Some(flow) = flow_in_op_mut(&mut entry.op, id) {
                flow.response = Some(response.clone());
                flow.duration_ms = Some(duration_ms);
                flow.ttfb_ms = ttfb_ms;
                if let Some(matched_rule) = &matched_rule {
                    flow.matched_rule = Some(matched_rule.clone());
                }
                true
            } else {
                false
            };
            if changed {
                entry.bytes = entry.op.size();
                found = true;
            }
        }
        if found {
            self.evict();
        }
        found
    }

    /// Keep an authored comment current in any delete/clear snapshot. This also
    /// covers a delayed comment IPC that arrives while the live row is parked.
    pub fn set_flow_comment(&mut self, id: &str, comment: Option<String>) -> bool {
        let mut found = false;
        for entry in self.undo.iter_mut().chain(self.redo.iter_mut()) {
            let changed = if let Some(flow) = flow_in_op_mut(&mut entry.op, id) {
                flow.comment.clone_from(&comment);
                true
            } else {
                false
            };
            if changed {
                entry.bytes = entry.op.size();
                found = true;
            }
        }
        if found {
            self.evict();
        }
        found
    }

    /// Availability checks are asynchronous and may finish while their flow is
    /// parked in history. Retain the verdict so a later undo restores it too.
    pub fn set_flow_availability(&mut self, id: &str, availability: Availability) -> bool {
        let mut found = false;
        for entry in self.undo.iter_mut().chain(self.redo.iter_mut()) {
            if let Some(flow) = flow_in_op_mut(&mut entry.op, id) {
                flow.availability = Some(availability.clone());
                found = true;
            }
        }
        found
    }

    #[cfg(test)]
    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn can_redo(&self) -> bool {
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

    /// Entry ids as a timeline: applied entries oldest→newest, then undone
    /// (future) entries in chronological order — the redo stack is LIFO (top =
    /// next to reapply), so it reads reversed. Test observation seam.
    #[cfg(test)]
    pub(crate) fn timeline_ids(&self) -> Vec<u64> {
        self.undo
            .iter()
            .map(|e| e.id)
            .chain(self.redo.iter().rev().map(|e| e.id))
            .collect()
    }

    fn evict(&mut self) {
        while self.undo.len() > self.depth_cap {
            self.undo.remove(0);
        }
        while self.total_bytes() > self.byte_cap {
            if self.undo.len() > 1 {
                self.undo.remove(0);
                continue;
            }
            // Late response bodies can enlarge an entry after it moved to the
            // redo stack. Drop the farthest future first (index 0); the top at
            // the end remains the next action the user can redo. Keep at least
            // one entry overall even when that single operation exceeds the
            // soft byte cap.
            if !self.redo.is_empty() && (!self.undo.is_empty() || self.redo.len() > 1) {
                self.redo.remove(0);
                continue;
            }
            break;
        }
    }

    fn total_bytes(&self) -> usize {
        self.undo
            .iter()
            .chain(&self.redo)
            .fold(0, |total, entry| total.saturating_add(entry.bytes))
    }
}

fn flow_in_op_mut<'a>(op: &'a mut HistoryOp, id: &str) -> Option<&'a mut Flow> {
    match op {
        HistoryOp::FlowsRemoved { items } => items
            .iter_mut()
            .find_map(|(_, flow)| (flow.id == id).then_some(flow)),
        HistoryOp::FlowsCleared { flows } => flows.iter_mut().find(|flow| flow.id == id),
        HistoryOp::Mock { .. } => None,
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

    fn ar_with_body(body: &str) -> AutoResponder {
        AutoResponder {
            scenarios: vec![crate::rules::Scenario {
                id: "s".into(),
                name: "s".into(),
                rules: vec![crate::rules::Rule {
                    id: "r".into(),
                    enabled: true,
                    fire_limit: None,
                    repeat: false,
                    matcher: crate::rules::Matcher {
                        method: None,
                        url: "/".into(),
                        url_match: crate::rules::MatchKind::Contains,
                    },
                    action: Action::Respond {
                        status: 200,
                        headers: Vec::new(),
                        body: body.into(),
                        body_base64: None,
                        content_type: None,
                        content_encoding: None,
                    },
                }],
            }],
            active_scenario_id: Some("s".into()),
            general_active: true,
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
        h.record(
            mock(Some("base"), Some("typed1")),
            HistoryTag::new("Edit rule", edit.clone()),
        );
        h.record(
            mock(Some("typed1"), Some("typed2")),
            HistoryTag::new("Edit rule", edit),
        );
        assert_eq!(h.undo.len(), 1, "the typing coalesces into one entry");

        h.record(
            mock(Some("typed2"), Some("formatted")),
            HistoryTag::new("Format body", None),
        );
        assert_eq!(
            h.undo.len(),
            2,
            "a no-key commit never folds into the coalesced edit run"
        );
        assert_eq!(after_of(&h.undo[1].op).as_deref(), Some("formatted"));
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
        h.record(
            mock(Some("base"), Some("a")),
            HistoryTag::new("edit", key.clone()),
        );
        h.record(
            mock(Some("a"), Some("ab")),
            HistoryTag::new("edit", key.clone()),
        );
        h.record(mock(Some("ab"), Some("abc")), HistoryTag::new("edit", key));

        assert_eq!(h.undo.len(), 1, "three keyed edits collapse to one entry");
        let HistoryOp::Mock { before, .. } = &h.undo[0].op else {
            panic!("expected a mock op");
        };
        assert_eq!(
            before.active_scenario_id.as_deref(),
            Some("base"),
            "first before is kept"
        );
        assert_eq!(
            after_of(&h.undo[0].op).as_deref(),
            Some("abc"),
            "latest after wins"
        );
    }

    #[test]
    fn different_key_starts_a_new_entry() {
        let mut h = History::default();
        h.record(
            mock(None, Some("a")),
            HistoryTag::new("a", Some("k1".into())),
        );
        h.record(
            mock(Some("a"), Some("b")),
            HistoryTag::new("b", Some("k2".into())),
        );
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
            bytes: 0,
        });
        h.record(mock(None, Some("a")), HistoryTag::new("edit", key));
        assert_eq!(h.undo.len(), 1);
        assert!(
            h.open_key.is_some(),
            "the fresh record opens a new coalescing window"
        );
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
            h.record(
                mock(None, Some(&format!("s{i}"))),
                HistoryTag::new("e", None),
            );
        }
        assert_eq!(h.undo.len(), 3, "capped at depth 3");
        assert_eq!(
            after_of(&h.undo[0].op).as_deref(),
            Some("s2"),
            "two oldest evicted"
        );
    }

    #[test]
    fn byte_cap_evicts_the_farthest_future_before_the_next_redo() {
        let mut h = History::with_caps(10, 100);
        h.redo = vec![
            HistoryEntry {
                id: 3,
                op: mock(Some("b"), Some("c")),
                bytes: 80,
            },
            HistoryEntry {
                id: 2,
                op: mock(Some("a"), Some("b")),
                bytes: 80,
            },
        ];

        h.evict();

        assert_eq!(h.redo.len(), 1);
        assert_eq!(h.redo[0].id, 2, "the immediately redoable entry survives");
    }

    #[test]
    fn timeline_orders_applied_then_future_chronologically() {
        let mut h = History::default();
        h.record(mock(None, Some("a")), HistoryTag::new("A", None));
        h.record(mock(Some("a"), Some("b")), HistoryTag::new("B", None));
        h.record(mock(Some("b"), Some("c")), HistoryTag::new("C", None));
        let recorded = h.timeline_ids();
        // Undo two → redo stack holds C then B (B on top).
        let c = h.take_undo().unwrap();
        h.stash_redo(c);
        let b = h.take_undo().unwrap();
        h.stash_redo(b);

        assert_eq!(
            h.timeline_ids(),
            recorded,
            "applied (A) first, then future B, C in chronological order"
        );
        assert!(h.can_undo() && h.can_redo());
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

    #[test]
    fn coalescing_recomputes_size_from_the_retained_before_snapshot() {
        let mut h = History::default();
        let key = Some("edit:r".to_string());
        h.record(
            HistoryOp::Mock {
                before: ar_with_body("small"),
                after: ar_with_body(&"x".repeat(10_000)),
            },
            HistoryTag::new("edit", key.clone()),
        );
        h.record(
            HistoryOp::Mock {
                before: ar_with_body(&"x".repeat(10_000)),
                after: ar_with_body("latest"),
            },
            HistoryTag::new("edit", key),
        );

        assert_eq!(h.undo.len(), 1);
        assert_eq!(h.undo[0].bytes, h.undo[0].op.size());
    }

    #[test]
    fn mock_size_budget_counts_large_non_body_rule_fields() {
        let mut autoresponder = ar_with_body("");
        let rule = &mut autoresponder.scenarios[0].rules[0];
        rule.matcher.url = "u".repeat(10_000);
        rule.action = Action::SetResponseHeader {
            name: "x-large".into(),
            value: "v".repeat(20_000),
        };

        assert!(
            ar_size(&autoresponder) >= 30_000,
            "matcher and action strings must count toward history retention"
        );
    }
}
