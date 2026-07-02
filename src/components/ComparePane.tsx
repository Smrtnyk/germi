import {
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { flowUrl } from "../flowUrl";
import { KIND_CHIPS, statusCls } from "../filter";
import {
  MATCH_HIGHLIGHT_MIN,
  PANE_COLUMNS,
  type PaneColumnId,
  type PaneQuery,
  type PaneSelection,
} from "../comparePane";
import { IconSortAsc, IconSortDesc, IconSortNone } from "./icons";
import type { SortState } from "../sort";
import type { FlowSummary, ResourceKind } from "../types";

/** Match badge tone: good matches read green, weak ones fade out. */
function matchTone(pct: number): string {
  if (pct >= MATCH_HIGHLIGHT_MIN) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

/** Esc clears the pane filter first, then leaves it; the window-level handler
 *  ignores keys while typing, so this never double-fires a close. */
function filterKeys(e: KeyboardEvent<HTMLInputElement>, onFilterChange: (f: string) => void) {
  if (e.key !== "Escape") return;
  const input = e.currentTarget;
  if (input.value) {
    e.preventDefault();
    onFilterChange("");
  } else {
    input.blur();
  }
}

function PaneTools({
  query,
  onFilterChange,
  onToggleKind,
}: {
  query: PaneQuery;
  onFilterChange: (filter: string) => void;
  onToggleKind: (kind: ResourceKind) => void;
}) {
  return (
    <div className="compare-tools">
      <input
        className="compare-filter"
        placeholder="Filter (host: status:4xx …)"
        value={query.filter}
        onChange={(e) => onFilterChange(e.target.value)}
        onKeyDown={(e) => filterKeys(e, onFilterChange)}
      />
      <div className="compare-chips">
        {KIND_CHIPS.map(({ kind, label }) => (
          <button
            key={kind}
            className={query.kinds.has(kind) ? "fchip on" : "fchip"}
            onClick={() => onToggleKind(kind)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function sortIcon(sort: SortState | null, columnId: PaneColumnId) {
  if (sort?.columnId !== columnId) return <IconSortNone />;
  return sort.dir === "asc" ? <IconSortAsc /> : <IconSortDesc />;
}

function PaneColumnHead({
  sort,
  onToggleSort,
}: {
  sort: SortState | null;
  onToggleSort: (columnId: PaneColumnId) => void;
}) {
  return (
    <div className="compare-grid compare-cols">
      {PANE_COLUMNS.map((c) => (
        <button
          key={c.id}
          className={sort?.columnId === c.id ? "compare-col sorted" : "compare-col"}
          onClick={() => onToggleSort(c.id)}
          title={`Sort by ${c.label}`}
        >
          {c.label} {sortIcon(sort, c.id)}
        </button>
      ))}
    </div>
  );
}

function rowClass(f: FlowSummary, selection: PaneSelection, hit: boolean, tint: "a" | "b"): string {
  const parts = ["compare-row", "compare-grid"];
  if (hit) parts.push(`hit-${tint}`);
  if (selection.selectedIds.has(f.id)) parts.push("checked");
  if (selection.focusedId === f.id) parts.push("selected");
  return parts.join(" ");
}

interface PaneRowProps {
  f: FlowSummary;
  selection: PaneSelection;
  match: number | undefined;
  tint: "a" | "b";
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onRowMove: (id: string) => void;
  moveHint: string;
  style: { transform: string; height: number };
}

function PaneRow({
  f,
  selection,
  match,
  tint,
  onRowClick,
  onRowMove,
  moveHint,
  style,
}: PaneRowProps) {
  const hit = match !== undefined && match >= MATCH_HIGHLIGHT_MIN;
  return (
    <div
      className={rowClass(f, selection, hit, tint)}
      style={style}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => onRowClick(f.id, e)}
      onDoubleClick={() => onRowMove(f.id)}
      title={`${flowUrl(f)}\nDouble-click: ${moveHint}`}
    >
      <span className="compare-seq">{f.seq}</span>
      <span className={`badge m-${f.method.toLowerCase()}`}>{f.method}</span>
      <span className={`multi-code ${statusCls(f.status)}`}>{f.status ?? "···"}</span>
      <span className="compare-host">{f.host}</span>
      <span className="compare-path">{f.path}</span>
      {match !== undefined && <span className={`compare-match ${matchTone(match)}`}>{match}%</span>}
    </div>
  );
}

export interface ComparePaneProps {
  title: string;
  emptyHint: string;
  /** The visible rows (already filtered + sorted — see `visiblePaneFlows`). */
  rows: FlowSummary[];
  /** Pane size before filtering, for the "n of m" count. */
  total: number;
  selection: PaneSelection;
  active: boolean;
  /** Similarity vs the other side's focused row, or null when it has none. */
  matches: Map<string, number> | null;
  /** Which good-match tint this side uses (A = left pane, B = right pane). */
  tint: "a" | "b";
  query: PaneQuery;
  onFilterChange: (filter: string) => void;
  onToggleKind: (kind: ResourceKind) => void;
  onToggleSort: (columnId: PaneColumnId) => void;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onRowMove: (id: string) => void;
  moveHint: string;
  actions?: ReactNode;
}

/** One side of the compare picker: a filterable, sortable, multi-selectable
 *  request table whose rows carry a URL-match badge (and a full-row tint for
 *  good matches) against the other side's focused row. */
export function ComparePane(props: ComparePaneProps) {
  const { title, emptyHint, rows, total, query, actions } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });
  const filtered = rows.length !== total;
  return (
    <div className={props.active ? "compare-pane active" : "compare-pane"}>
      <div className="compare-pane-head">
        <span className="compare-pane-title">{title}</span>
        <span className="compare-count">{filtered ? `${rows.length} of ${total}` : total}</span>
        <div className="spacer" />
        {actions}
      </div>
      <PaneTools
        query={query}
        onFilterChange={props.onFilterChange}
        onToggleKind={props.onToggleKind}
      />
      <PaneColumnHead sort={query.sort} onToggleSort={props.onToggleSort} />
      {rows.length === 0 ? (
        <div className="compare-empty muted">
          {total > 0 ? "Nothing matches the filter" : emptyHint}
        </div>
      ) : (
        <div ref={parentRef} className="compare-list">
          <div className="compare-canvas" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const f = rows[item.index];
              return (
                <PaneRow
                  key={f.id}
                  f={f}
                  selection={props.selection}
                  match={props.matches?.get(f.id)}
                  tint={props.tint}
                  onRowClick={props.onRowClick}
                  onRowMove={props.onRowMove}
                  moveHint={props.moveHint}
                  style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
