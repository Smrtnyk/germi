import { parseFilter } from "./filter";
import { rangeSelection, toggleSelection } from "./selection";
import type { SortState } from "./sort";
import type { FlowSummary, ResourceKind } from "./types";

// Pure list pipeline + selection transitions for the compare panes (issue #86
// PR feedback): per-pane token filter, kind chips, sortable columns, and
// shift/ctrl multi-select. Rendering lives in ComparePane.tsx.

export type PaneColumnId = "seq" | "method" | "status" | "host" | "path" | "match";

export const PANE_COLUMNS: { id: PaneColumnId; label: string }[] = [
  { id: "seq", label: "#" },
  { id: "method", label: "Method" },
  { id: "status", label: "Status" },
  { id: "host", label: "Host" },
  { id: "path", label: "Path" },
  { id: "match", label: "Match" },
];

/** Match percentage from which a row counts as a "good" match: it gets the
 *  full-row tint and the green badge tone. */
export const MATCH_HIGHLIGHT_MIN = 80;

export interface PaneQuery {
  filter: string;
  kinds: Set<ResourceKind>;
  sort: SortState | null;
}

export function emptyPaneQuery(): PaneQuery {
  return { filter: "", kinds: new Set(), sort: null };
}

type SortValue = string | number;

const ACCESSORS: Record<PaneColumnId, (f: FlowSummary, match: number | undefined) => SortValue> = {
  seq: (f) => f.seq,
  method: (f) => f.method,
  status: (f) => f.status ?? -1,
  host: (f) => f.host,
  path: (f) => f.path,
  match: (_f, match) => match ?? -1,
};

function comparePaneValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function sortPaneFlows(
  flows: FlowSummary[],
  sort: SortState,
  matches: Map<string, number> | null,
): FlowSummary[] {
  const accessor = ACCESSORS[sort.columnId as PaneColumnId];
  if (!accessor) return flows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return flows
    .map((f, i) => ({ f, i, v: accessor(f, matches?.get(f.id)) }))
    .sort((x, y) => comparePaneValues(x.v, y.v) * sign || x.i - y.i)
    .map((x) => x.f);
}

/** The rows a pane displays: kind-chipped, token-filtered (same syntax as the
 *  main traffic filter; content terms are ignored — no backend scan here),
 *  then sorted. Insertion order when no sort is active. */
export function visiblePaneFlows(
  flows: FlowSummary[],
  query: PaneQuery,
  matches: Map<string, number> | null,
): FlowSummary[] {
  const parsed = parseFilter(query.filter);
  const kept = flows.filter(
    (f) => (query.kinds.size === 0 || query.kinds.has(f.kind)) && parsed.matchSummary(f),
  );
  return query.sort ? sortPaneFlows(kept, query.sort, matches) : kept;
}

// ---- filter linking across the two panes (issue #88) ----

/** True when the query carries any filter state (text or kind chips); the
 *  sort is a per-pane view preference and never counts. */
export function hasPaneFilter(query: PaneQuery): boolean {
  return query.filter.trim() !== "" || query.kinds.size > 0;
}

/** Copy the filter half (text + kind chips) of `source` onto `target`,
 *  leaving the target's own sort alone. */
export function copyPaneFilter(source: PaneQuery, target: PaneQuery): PaneQuery {
  return { ...target, filter: source.filter, kinds: new Set(source.kinds) };
}

/** The side whose filter survives when the panes get (re-)linked: the only
 *  side that has one, or the left side when both (or neither) do. */
export function linkSourceSide(left: PaneQuery, right: PaneQuery): "left" | "right" {
  return hasPaneFilter(right) && !hasPaneFilter(left) ? "right" : "left";
}

// ---- selection (single focus + shift/ctrl multi-select, per pane) ----

export interface PaneSelection {
  selectedIds: Set<string>;
  /** The row keyboard/diff actions operate on (last interacted). */
  focusedId: string | null;
  /** Range anchor for shift-click / shift-arrows. */
  anchorId: string | null;
}

export function selectOnly(id: string | null): PaneSelection {
  return id === null
    ? { selectedIds: new Set(), focusedId: null, anchorId: null }
    : { selectedIds: new Set([id]), focusedId: id, anchorId: id };
}

export function selectMany(ids: string[]): PaneSelection {
  if (ids.length === 0) return selectOnly(null);
  return { selectedIds: new Set(ids), focusedId: ids[0], anchorId: ids[0] };
}

/** Ctrl/⌘+A over a pane: select every visible row, focusing the last and
 *  anchoring the first — mirrors the main traffic list's select-all. An empty
 *  list is a no-op (the current selection stands). */
export function selectAll(sel: PaneSelection, ids: string[]): PaneSelection {
  if (ids.length === 0) return sel;
  return { selectedIds: new Set(ids), focusedId: ids[ids.length - 1], anchorId: ids[0] };
}

export type SelectMode = "single" | "toggle" | "range";

/** Click transition: plain click selects one, ctrl/⌘ toggles, shift ranges
 *  from the anchor (falling back to a fresh single when the anchor is gone). */
export function selectRow(
  sel: PaneSelection,
  visibleIds: string[],
  id: string,
  mode: SelectMode,
): PaneSelection {
  if (mode === "toggle") {
    const patch = toggleSelection(visibleIds, sel.selectedIds, sel.focusedId, id);
    return { selectedIds: patch.selectedIds, focusedId: patch.selectedId, anchorId: patch.anchor };
  }
  if (mode === "range") {
    const anchor = sel.anchorId ?? id;
    const range = rangeSelection(visibleIds, anchor, id);
    if (range) return { selectedIds: range, focusedId: id, anchorId: anchor };
  }
  return selectOnly(id);
}

/** ↑/↓ transition over the visible order; `extend` (shift) grows the range
 *  from the anchor instead of collapsing to a single selection. */
export function stepSelection(
  sel: PaneSelection,
  visibleIds: string[],
  dir: 1 | -1,
  extend: boolean,
): PaneSelection {
  if (visibleIds.length === 0) return sel;
  const idx = sel.focusedId === null ? -1 : visibleIds.indexOf(sel.focusedId);
  const next =
    idx === -1
      ? visibleIds[dir === 1 ? 0 : visibleIds.length - 1]
      : visibleIds[Math.min(visibleIds.length - 1, Math.max(0, idx + dir))];
  return selectRow(sel, visibleIds, next, extend ? "range" : "single");
}

// ---- moving rows across panes ----

export interface Extraction {
  rest: FlowSummary[];
  moved: FlowSummary[];
  /** Suggested focus in the source pane: the row that takes the visual place
   *  of the first removed one. */
  nextFocus: string | null;
}

/** Remove `ids` from `list` (keeping list order); null when none are present. */
export function extractFlows(list: FlowSummary[], ids: Set<string>): Extraction | null {
  const firstIdx = list.findIndex((f) => ids.has(f.id));
  if (firstIdx === -1) return null;
  const moved = list.filter((f) => ids.has(f.id));
  const rest = list.filter((f) => !ids.has(f.id));
  return { rest, moved, nextFocus: rest[Math.min(firstIdx, rest.length - 1)]?.id ?? null };
}

/** Everything one pane owns: its rows, its selection, and its view query. */
export interface PaneData {
  flows: FlowSummary[];
  sel: PaneSelection;
  query: PaneQuery;
}

export function paneData(flows: FlowSummary[]): PaneData {
  return { flows, sel: selectOnly(flows[0]?.id ?? null), query: emptyPaneQuery() };
}

/** Move rows across panes: `ids`, or the source's visible selection when null.
 *  The source focuses the row taking the first moved one's place; the moved
 *  rows arrive at the destination's tail as its new selection. */
export function movePaneFlows(
  from: PaneData,
  to: PaneData,
  fromVisibleIds: string[],
  ids: Set<string> | null,
): { from: PaneData; to: PaneData } | null {
  const wanted = ids ?? new Set(fromVisibleIds.filter((id) => from.sel.selectedIds.has(id)));
  const extraction = extractFlows(from.flows, wanted);
  if (!extraction) return null;
  return {
    from: { ...from, flows: extraction.rest, sel: selectOnly(extraction.nextFocus) },
    to: {
      ...to,
      flows: [...to.flows, ...extraction.moved],
      sel: selectMany(extraction.moved.map((f) => f.id)),
    },
  };
}
