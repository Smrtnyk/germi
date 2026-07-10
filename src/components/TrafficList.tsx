import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isPlainObject, sumBy } from "es-toolkit";

import type { Availability, FlowSummary } from "../types";
import type { ColumnDef } from "../columns";
import type { SortState } from "../sort";
import { availabilityLabel } from "../availability";
import type { RowTint } from "../savedFilters";
import { flowUrl } from "../flowUrl";
import { dragFlowIds, encodeFlowIds, FLOW_DRAG_MIME } from "../dnd";
import { useToast } from "../toast";
import { copyText } from "../useCopy";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  availabilityToneIcon,
  IconArrowDown,
  IconCompare,
  IconMock,
  IconSortAsc,
  IconSortDesc,
  IconSortNone,
} from "./icons";
import { MatchRail } from "./MatchRail";

/** The filter-view state the list renders against (issue #90). */
interface ListView {
  /** Ids to keep at full opacity (dim mode), or null when nothing dims. */
  matchedIds: Set<string> | null;
  /** flow id → saved-filter highlight; rows get tinted with it. */
  savedTints: Map<string, RowTint>;
  /** How many flows exist before filtering — drives the "all hidden" empty state. */
  totalCount: number;
}

interface Props {
  flows: FlowSummary[];
  view: ListView;
  columns: ColumnDef[];
  sort: SortState | null;
  onToggleSort: (columnId: string) => void;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onKeySelect: (id: string, extend: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onCommentEdit: (id: string, comment: string | null) => void;
  onMockFlow: (id: string) => void;
  onFilterToHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onCopyCurl: (id: string) => void;
  onCopyBody: (id: string) => void;
  onCompareSelected: () => void;
  /** Viewer mode disables the autoresponder, so the "Mock" action is hidden. */
  viewer: boolean;
}

const MIN_W = 38;
const STORE_KEY = "germi.colWidths";
const GAP = 8;
const ROW_PAD = 20;
const BOTTOM_SLACK = 40;

function loadWidths(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return isPlainObject(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function statusClass(status: number | null): string {
  if (status === null) return "pending";
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 300) return "s3";
  return "s2";
}

function makeDragGhost(count: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "flow-drag-ghost";
  el.textContent = `⚡ Mock ${count} requests`;
  document.body.appendChild(el);
  return el;
}

interface Menu {
  x: number;
  y: number;
  flow: FlowSummary;
}

interface ColumnWidths {
  widthOf: (c: ColumnDef) => number;
  resetWidth: (id: string, width: number) => void;
  startResize: (e: ReactPointerEvent, c: ColumnDef) => void;
}

function useColumnWidths(): ColumnWidths {
  const [widths, setWidths] = useState<Record<string, number>>(loadWidths);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(widths));
  }, [widths]);

  const widthOf = (c: ColumnDef) => {
    const w = widths[c.id];
    return typeof w === "number" && Number.isFinite(w) && w >= MIN_W ? w : c.width;
  };

  const resetWidth = (id: string, width: number) => {
    setWidths((prev) => ({ ...prev, [id]: width }));
  };

  function startResize(e: ReactPointerEvent, c: ColumnDef) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W, Math.round(startW + (ev.clientX - startX)));
      setWidths((prev) => (prev[c.id] === w ? prev : { ...prev, [c.id]: w }));
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  return { widthOf, resetWidth, startResize };
}

interface FollowTail {
  follow: boolean;
  newCount: number;
  stopFollowing: () => void;
  onScroll: () => void;
  jumpToLatest: () => void;
}

function useFollowTail(
  flows: FlowSummary[],
  parentRef: React.RefObject<HTMLDivElement | null>,
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>,
  enabled: boolean,
): FollowTail {
  const [follow, setFollow] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevLen = useRef(flows.length);

  // Live-capture follow: stick to the newest row while following; otherwise
  // accrue a "new" count so the user can jump back without losing their place.
  useEffect(() => {
    const grew = flows.length - prevLen.current;
    if (enabled && grew > 0) {
      if (follow) virtualizer.scrollToIndex(flows.length - 1, { align: "end" });
      else setNewCount((c) => c + grew);
    } else if (flows.length < prevLen.current) {
      setNewCount(0);
    }
    prevLen.current = flows.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows.length, follow, enabled]);

  function onScroll() {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom) {
      if (!follow) setFollow(true);
      if (newCount) setNewCount(0);
    } else if (follow) {
      setFollow(false);
    }
  }

  function jumpToLatest() {
    setFollow(true);
    setNewCount(0);
    if (flows.length) virtualizer.scrollToIndex(flows.length - 1, { align: "end" });
  }

  return { follow, newCount, stopFollowing: () => setFollow(false), onScroll, jumpToLatest };
}

interface CommentDraft {
  editingId: string | null;
  draft: string;
  cancelEdit: React.MutableRefObject<boolean>;
  setDraft: (v: string) => void;
  setEditingId: (id: string | null) => void;
  beginEdit: (f: FlowSummary) => void;
  commitComment: (id: string) => void;
}

function useCommentDraft(
  onCommentEdit: (id: string, comment: string | null) => void,
): CommentDraft {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const cancelEdit = useRef(false);

  function commitComment(id: string) {
    onCommentEdit(id, draft.trim() || null);
    setEditingId(null);
  }

  function beginEdit(f: FlowSummary) {
    setEditingId(f.id);
    setDraft(f.comment ?? "");
  }

  return { editingId, draft, cancelEdit, setDraft, setEditingId, beginEdit, commitComment };
}

interface HeaderRowProps {
  columns: ColumnDef[];
  headerRef: React.RefObject<HTMLDivElement | null>;
  sort: SortState | null;
  onToggleSort: (columnId: string) => void;
  startResize: (e: ReactPointerEvent, c: ColumnDef) => void;
  resetWidth: (id: string, width: number) => void;
}

export function HeaderRow({
  columns,
  headerRef,
  sort,
  onToggleSort,
  startResize,
  resetWidth,
}: HeaderRowProps) {
  return (
    <div className="flow-row flow-head" ref={headerRef}>
      {columns.map((c) => {
        const active = sort?.columnId === c.id;
        const caret =
          active && sort ? (
            sort.dir === "asc" ? (
              <IconSortAsc />
            ) : (
              <IconSortDesc />
            )
          ) : (
            <IconSortNone />
          );
        return (
          <span key={c.id} className={c.align === "right" ? "cell-right" : ""}>
            {c.sortKey ? (
              <button
                type="button"
                className={`col-sort${active ? " active" : ""}`}
                onClick={() => onToggleSort(c.id)}
                title={`Sort by ${c.label}`}
              >
                <span className="col-sort-label">{c.label}</span>
                <span className="sort-caret" aria-hidden="true">
                  {caret}
                </span>
              </button>
            ) : (
              c.label
            )}
            <span
              className="col-resize right"
              onPointerDown={(e) => startResize(e, c)}
              onDoubleClick={() => resetWidth(c.id, c.width)}
              title="Drag to resize · double-click to reset"
            />
          </span>
        );
      })}
    </div>
  );
}

interface FlowCellProps {
  c: ColumnDef;
  f: FlowSummary;
  comments: CommentDraft;
}

/** The inline public-availability marker shown beside the status code on a
 *  checked doc row — a compact colored glyph whose tooltip carries the worded
 *  verdict and evidence. Nothing for unchecked flows. (The full worded result
 *  lives in the Inspector's "Public availability" panel.) */
function AvailabilityBadge({ availability }: { availability: Availability | null }) {
  if (!availability) return null;
  const { tone, title } = availabilityLabel(availability);
  const AvailIcon = availabilityToneIcon[tone];
  return (
    <span className={`avail-icon avail-${tone}`} title={title} aria-label={title}>
      <AvailIcon />
    </span>
  );
}

function AvailabilityCell({ availability }: { availability: Availability | null }) {
  if (!availability) return <span className="c-avail" />;
  const { text, tone, title } = availabilityLabel(availability);
  const AvailIcon = availabilityToneIcon[tone];
  return (
    <span className={`c-avail avail-${tone}`} title={title}>
      <AvailIcon /> {text}
    </span>
  );
}

function FlowCell({ c, f, comments }: FlowCellProps) {
  if (c.special === "method") {
    return <span className={`c-method m-${f.method.toLowerCase()}`}>{f.method}</span>;
  }
  if (c.special === "status") {
    // One wrapper element so this stays a SINGLE grid cell — a fragment would
    // emit two grid items and shift every later column out of header alignment.
    return (
      <span className="c-status-cell">
        <span className={`c-status ${statusClass(f.status)}`}>{f.status ?? "···"}</span>
        <AvailabilityBadge availability={f.availability} />
      </span>
    );
  }
  if (c.special === "kind") {
    return <span className="c-kind">{f.kind}</span>;
  }
  if (c.special === "availability") {
    return <AvailabilityCell availability={f.availability} />;
  }
  if (c.special === "comment") {
    return <CommentCell f={f} comments={comments} />;
  }
  const txt = c.text(f);
  return (
    <span className={c.align === "right" ? "cell-right" : ""} title={txt || undefined}>
      {txt}
    </span>
  );
}

interface CommentCellProps {
  f: FlowSummary;
  comments: CommentDraft;
}

export function CommentCell({ f, comments }: CommentCellProps) {
  const { editingId, draft, cancelEdit, setDraft, setEditingId, beginEdit, commitComment } =
    comments;
  const editing = editingId === f.id;
  return (
    <span
      className="c-comment"
      onClick={(e) => {
        e.stopPropagation();
        if (!editing) beginEdit(f);
      }}
    >
      {editing ? (
        <input
          className="comment-input"
          autoFocus
          value={draft}
          placeholder="note…"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              cancelEdit.current = true;
              commitComment(f.id);
            } else if (e.key === "Escape") {
              cancelEdit.current = true;
              setEditingId(null);
            }
          }}
          onBlur={(e) => {
            if (cancelEdit.current || !e.currentTarget.isConnected) {
              cancelEdit.current = false;
              return;
            }
            commitComment(f.id);
          }}
        />
      ) : f.comment ? (
        <span className="comment-text">{f.comment}</span>
      ) : (
        <span className="comment-add">+ note</span>
      )}
    </span>
  );
}

interface FlowRowProps {
  f: FlowSummary;
  item: { start: number; size: number };
  columns: ColumnDef[];
  selected: boolean;
  inSet: boolean;
  matched: boolean;
  dimmed: boolean;
  tint: RowTint | undefined;
  comments: CommentDraft;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onActivate: () => void;
  onOpenMenu: (e: ReactMouseEvent, f: FlowSummary) => void;
  onDragStart: (e: ReactDragEvent, f: FlowSummary) => void;
}

/** Row tooltip: combine the "imported from file" marker hint with the mocked-by
 *  rule and saved-filter highlight hints, so every cue is explained on hover. */
function rowTitle(f: FlowSummary, tint: RowTint | undefined): string | undefined {
  const parts: string[] = [];
  if (f.imported) parts.push("imported from file");
  if (f.matchedRule) parts.push(`mocked by rule: ${f.matchedRule}`);
  if (tint) parts.push(`saved filter: ${tint.label}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function rowClass(
  f: FlowSummary,
  s: Pick<FlowRowProps, "selected" | "inSet" | "matched" | "dimmed">,
  tinted: boolean,
): string {
  return `flow-row ${s.selected ? "selected" : ""} ${s.inSet ? "checked" : ""} ${
    f.matchedRule ? "ruled" : ""
  } ${f.imported ? "imported" : ""} ${s.matched ? "match" : ""} ${s.dimmed ? "dim" : ""} ${
    tinted ? "tinted" : ""
  }`;
}

function rowStyle(item: { start: number; size: number }, tint: RowTint | undefined): CSSProperties {
  return {
    transform: `translateY(${item.start}px)`,
    height: item.size,
    ...(tint ? ({ "--row-tint": tint.color } as CSSProperties) : null),
  };
}

function suppressShiftSelect(e: ReactMouseEvent) {
  if (!e.shiftKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
}

export function FlowRow({
  f,
  item,
  columns,
  selected,
  inSet,
  matched,
  dimmed,
  tint,
  comments,
  onRowClick,
  onActivate,
  onOpenMenu,
  onDragStart,
}: FlowRowProps) {
  // The tint yields to selection backgrounds; the row title keeps naming the
  // filter either way.
  const tinted = !!tint && !selected && !inSet;
  return (
    <div
      className={rowClass(f, { selected, inSet, matched, dimmed }, tinted)}
      style={rowStyle(item, tinted ? tint : undefined)}
      draggable
      onDragStart={(e) => onDragStart(e, f)}
      onMouseDown={suppressShiftSelect}
      onClick={(e) => {
        onRowClick(f.id, e);
        onActivate();
      }}
      onContextMenu={(e) => onOpenMenu(e, f)}
      title={rowTitle(f, tint)}
    >
      {columns.map((c) => (
        <FlowCell key={c.id} c={c} f={f} comments={comments} />
      ))}
    </div>
  );
}

interface ColumnLayout {
  cols: string;
  rowWidth: number;
}

function useColumnLayout(columns: ColumnDef[], widthOf: (c: ColumnDef) => number): ColumnLayout {
  const cols = `${columns.map((c) => `${widthOf(c)}px`).join(" ")} minmax(0, 1fr)`;
  const rowWidth = sumBy(columns, widthOf) + GAP * columns.length + ROW_PAD;
  return { cols, rowWidth };
}

interface MenuActions {
  beginEdit: (f: FlowSummary) => void;
  onMockFlow: (id: string) => void;
  /** False in viewer mode: omit the "Mock this" item (autoresponder disabled). */
  canMock: boolean;
  onFilterToHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onCopyCurl: (id: string) => void;
  onCopyBody: (id: string) => void;
  onCompareSelected: () => void;
  onDeleteSelected: () => void;
}

function menuItemsFor(
  f: FlowSummary,
  a: MenuActions,
  notify: ReturnType<typeof useToast>,
  selectedCount: number,
): MenuItem[] {
  return [
    ...(a.canMock
      ? [
          {
            label: (
              <>
                <IconMock /> Mock this
              </>
            ),
            onClick: () => a.onMockFlow(f.id),
          },
        ]
      : []),
    { label: "Add note", onClick: () => a.beginEdit(f) },
    {
      label: (
        <>
          <IconCompare />{" "}
          {selectedCount === 2 ? "Diff the 2 selected…" : `Compare ${selectedCount} selected…`}
        </>
      ),
      onClick: () => a.onCompareSelected(),
    },
    { label: "", sep: true, onClick: () => {} },
    {
      label: "Copy URL",
      onClick: () => {
        void copyText(notify, "URL", flowUrl(f));
      },
    },
    { label: "Copy as cURL", onClick: () => a.onCopyCurl(f.id) },
    { label: "Copy body", onClick: () => a.onCopyBody(f.id) },
    { label: "", sep: true, onClick: () => {} },
    { label: `Filter to host: ${f.host}`, onClick: () => a.onFilterToHost(f.host) },
    { label: `Exclude host: ${f.host}`, onClick: () => a.onExcludeHost(f.host), danger: true },
    { label: "", sep: true, onClick: () => {} },
    {
      label: selectedCount > 1 ? `Delete ${selectedCount} requests` : "Delete request",
      onClick: () => a.onDeleteSelected(),
      danger: true,
    },
  ];
}

interface FlowMenu {
  openMenu: (e: ReactMouseEvent, f: FlowSummary) => void;
  menuEl: ReactElement | null;
}

function useFlowMenu(
  selectedId: string | null,
  selectedIds: Set<string>,
  onKeySelect: (id: string, extend: boolean) => void,
  actions: MenuActions,
): FlowMenu {
  const notify = useToast();
  const [menu, setMenu] = useState<Menu | null>(null);

  function openMenu(e: ReactMouseEvent, f: FlowSummary) {
    e.preventDefault();
    if (f.id !== selectedId && !selectedIds.has(f.id)) onKeySelect(f.id, false);
    setMenu({ x: e.clientX, y: e.clientY, flow: f });
  }

  const menuEl = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menuItemsFor(menu.flow, actions, notify, selectedIds.size)}
      onClose={() => setMenu(null)}
    />
  ) : null;

  return { openMenu, menuEl };
}

/** With flows captured but none visible, the blank list needs to say WHY: the
 *  active filters removed them, not a broken capture (issue #90). The remedy
 *  named here must work for every narrowing mechanism — the hide-mode bar
 *  filter AND a solo'd saved filter — which "Clear filters" does. */
function EmptyState({ totalCount }: { totalCount: number }) {
  if (totalCount > 0) {
    return (
      <div className="empty">
        All {totalCount} requests are hidden by the active filters — use{" "}
        <strong>Clear filters</strong> above to show everything.
      </div>
    );
  }
  return (
    <div className="empty">
      No traffic yet. Start the proxy, trust the CA, and point an app at
      <code> 127.0.0.1</code>.
    </div>
  );
}

interface FlowScrollProps {
  flows: FlowSummary[];
  view: ListView;
  columns: ColumnDef[];
  headerRef: React.RefObject<HTMLDivElement | null>;
  followEnabled: boolean;
  selectedId: string | null;
  selectedIds: Set<string>;
  comments: CommentDraft;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onKeySelect: (id: string, extend: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onOpenMenu: (e: ReactMouseEvent, f: FlowSummary) => void;
}

function FlowScroll({
  flows,
  view,
  columns,
  headerRef,
  followEnabled,
  selectedId,
  selectedIds,
  comments,
  onRowClick,
  onKeySelect,
  onClearSelection,
  onDeleteSelected,
  onOpenMenu,
}: FlowScrollProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 24,
  });
  const { follow, newCount, stopFollowing, onScroll, jumpToLatest } = useFollowTail(
    flows,
    parentRef,
    virtualizer,
    followEnabled,
  );

  function handleDragStart(e: ReactDragEvent, f: FlowSummary) {
    if ((e.target as HTMLElement).closest("input, textarea")) {
      e.preventDefault();
      return;
    }
    const ids = dragFlowIds(
      f.id,
      selectedIds,
      flows.map((fl) => fl.id),
    );
    e.dataTransfer.setData(FLOW_DRAG_MIME, encodeFlowIds(ids));
    e.dataTransfer.effectAllowed = "copy";
    if (ids.length > 1) {
      const ghost = makeDragGhost(ids.length);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      window.setTimeout(() => ghost.remove(), 0);
    }
  }

  function moveSelection(e: ReactKeyboardEvent) {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT"
    ) {
      return;
    }
    // A Ctrl/Meta/Alt chord (e.g. Ctrl+K palette) belongs to the global shortcut
    // handler, not list navigation — otherwise it would both move the selection
    // and fire the shortcut. Shift is allowed through (range-extend selection).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = flows.length;
    if (n === 0) return;
    const cur = selectedId ? flows.findIndex((f) => f.id === selectedId) : -1;
    let next = cur;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        next = cur < 0 ? 0 : Math.min(n - 1, cur + 1);
        break;
      case "ArrowUp":
      case "k":
        next = cur < 0 ? n - 1 : Math.max(0, cur - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "Escape":
        onClearSelection();
        return;
      case "Delete":
      case "Backspace":
        if (selectedIds.size > 0) {
          e.preventDefault();
          onDeleteSelected();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    stopFollowing();
    const id = flows[next].id;
    onKeySelect(id, e.shiftKey);
    virtualizer.scrollToIndex(next, { align: "auto" });
  }

  function handleScroll() {
    onScroll();
    const el = parentRef.current;
    if (el && headerRef.current) {
      headerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
  }

  function jumpTo(index: number) {
    stopFollowing();
    virtualizer.scrollToIndex(index, { align: "center" });
  }

  return (
    <div className="flow-scroll-area">
      <div
        className="flow-scroll"
        ref={parentRef}
        tabIndex={0}
        onKeyDown={moveSelection}
        onScroll={handleScroll}
      >
        <div className="flow-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const f = flows[item.index];
            return (
              <FlowRow
                key={f.id}
                f={f}
                item={item}
                columns={columns}
                selected={f.id === selectedId}
                inSet={selectedIds.has(f.id)}
                matched={view.matchedIds !== null && view.matchedIds.has(f.id)}
                dimmed={view.matchedIds !== null && !view.matchedIds.has(f.id)}
                tint={view.savedTints.get(f.id)}
                comments={comments}
                onRowClick={onRowClick}
                onActivate={() => {
                  stopFollowing();
                  parentRef.current?.focus({ preventScroll: true });
                }}
                onOpenMenu={onOpenMenu}
                onDragStart={handleDragStart}
              />
            );
          })}
        </div>

        {flows.length === 0 && <EmptyState totalCount={view.totalCount} />}
      </div>

      {view.matchedIds !== null && (
        <MatchRail flows={flows} matchedIds={view.matchedIds} onJump={jumpTo} />
      )}

      {!follow && newCount > 0 && (
        <button
          className="follow-pill"
          onClick={jumpToLatest}
          title="Jump to newest and resume tailing"
        >
          {newCount} new <IconArrowDown />
        </button>
      )}
    </div>
  );
}

export function TrafficList({
  flows,
  view,
  columns,
  sort,
  onToggleSort,
  selectedId,
  selectedIds,
  onRowClick,
  onKeySelect,
  onClearSelection,
  onDeleteSelected,
  onCommentEdit,
  onMockFlow,
  onFilterToHost,
  onExcludeHost,
  onCopyCurl,
  onCopyBody,
  onCompareSelected,
  viewer,
}: Props) {
  const headerRef = useRef<HTMLDivElement>(null);
  const { widthOf, resetWidth, startResize } = useColumnWidths();
  const comments = useCommentDraft(onCommentEdit);
  const { cols, rowWidth } = useColumnLayout(columns, widthOf);
  const { openMenu, menuEl } = useFlowMenu(selectedId, selectedIds, onKeySelect, {
    beginEdit: comments.beginEdit,
    onMockFlow,
    canMock: !viewer,
    onFilterToHost,
    onExcludeHost,
    onCopyCurl,
    onCopyBody,
    onCompareSelected,
    onDeleteSelected,
  });

  return (
    <div
      className="flow-list"
      style={{ "--cols": cols, "--row-w": `${rowWidth}px` } as CSSProperties}
    >
      <div className="flow-head-wrap">
        <HeaderRow
          columns={columns}
          headerRef={headerRef}
          sort={sort}
          onToggleSort={onToggleSort}
          startResize={startResize}
          resetWidth={resetWidth}
        />
      </div>

      <FlowScroll
        flows={flows}
        view={view}
        columns={columns}
        headerRef={headerRef}
        followEnabled={sort === null}
        selectedId={selectedId}
        selectedIds={selectedIds}
        comments={comments}
        onRowClick={onRowClick}
        onKeySelect={onKeySelect}
        onClearSelection={onClearSelection}
        onDeleteSelected={onDeleteSelected}
        onOpenMenu={openMenu}
      />

      {menuEl}
    </div>
  );
}
