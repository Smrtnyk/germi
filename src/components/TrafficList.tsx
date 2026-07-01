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
import { flowUrl } from "../flowUrl";
import { dragFlowIds, encodeFlowIds, FLOW_DRAG_MIME } from "../dnd";
import { useToast } from "../toast";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  availabilityToneIcon,
  IconArrowDown,
  IconMock,
  IconSortAsc,
  IconSortDesc,
  IconSortNone,
} from "./icons";
import { MatchRail } from "./MatchRail";

interface Props {
  flows: FlowSummary[];
  columns: ColumnDef[];
  sort: SortState | null;
  onToggleSort: (columnId: string) => void;
  matchedIds: Set<string> | null;
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
  comments: CommentDraft;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onActivate: () => void;
  onOpenMenu: (e: ReactMouseEvent, f: FlowSummary) => void;
  onDragStart: (e: ReactDragEvent, f: FlowSummary) => void;
}

/** Row tooltip: combine the "imported from file" marker hint with the mocked-by
 *  rule hint, so both cues are explained on hover. */
function rowTitle(f: FlowSummary): string | undefined {
  const parts: string[] = [];
  if (f.imported) parts.push("imported from file");
  if (f.matchedRule) parts.push(`mocked by rule: ${f.matchedRule}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function suppressShiftSelect(e: ReactMouseEvent) {
  if (!e.shiftKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
}

function FlowRow({
  f,
  item,
  columns,
  selected,
  inSet,
  matched,
  dimmed,
  comments,
  onRowClick,
  onActivate,
  onOpenMenu,
  onDragStart,
}: FlowRowProps) {
  return (
    <div
      className={`flow-row ${selected ? "selected" : ""} ${inSet ? "checked" : ""} ${
        f.matchedRule ? "ruled" : ""
      } ${f.imported ? "imported" : ""} ${matched ? "match" : ""} ${dimmed ? "dim" : ""}`}
      style={{ transform: `translateY(${item.start}px)`, height: item.size }}
      draggable
      onDragStart={(e) => onDragStart(e, f)}
      onMouseDown={suppressShiftSelect}
      onClick={(e) => {
        onRowClick(f.id, e);
        onActivate();
      }}
      onContextMenu={(e) => onOpenMenu(e, f)}
      title={rowTitle(f)}
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
  onFilterToHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onCopyCurl: (id: string) => void;
  onCopyBody: (id: string) => void;
  onDeleteSelected: () => void;
}

function menuItemsFor(
  f: FlowSummary,
  a: MenuActions,
  notify: ReturnType<typeof useToast>,
  selectedCount: number,
): MenuItem[] {
  return [
    {
      label: (
        <>
          <IconMock /> Mock this
        </>
      ),
      onClick: () => a.onMockFlow(f.id),
    },
    { label: "Add note", onClick: () => a.beginEdit(f) },
    { label: "", sep: true, onClick: () => {} },
    {
      label: "Copy URL",
      onClick: () => {
        void navigator.clipboard.writeText(flowUrl(f));
        notify("success", "URL copied");
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

interface FlowScrollProps {
  flows: FlowSummary[];
  columns: ColumnDef[];
  headerRef: React.RefObject<HTMLDivElement | null>;
  followEnabled: boolean;
  matchedIds: Set<string> | null;
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
  columns,
  headerRef,
  followEnabled,
  matchedIds,
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
                matched={matchedIds !== null && matchedIds.has(f.id)}
                dimmed={matchedIds !== null && !matchedIds.has(f.id)}
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

        {flows.length === 0 && (
          <div className="empty">
            No traffic yet. Start the proxy, trust the CA, and point an app at
            <code> 127.0.0.1</code>.
          </div>
        )}
      </div>

      {matchedIds !== null && <MatchRail flows={flows} matchedIds={matchedIds} onJump={jumpTo} />}

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
  columns,
  sort,
  onToggleSort,
  matchedIds,
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
}: Props) {
  const headerRef = useRef<HTMLDivElement>(null);
  const { widthOf, resetWidth, startResize } = useColumnWidths();
  const comments = useCommentDraft(onCommentEdit);
  const { cols, rowWidth } = useColumnLayout(columns, widthOf);
  const { openMenu, menuEl } = useFlowMenu(selectedId, selectedIds, onKeySelect, {
    beginEdit: comments.beginEdit,
    onMockFlow,
    onFilterToHost,
    onExcludeHost,
    onCopyCurl,
    onCopyBody,
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
        columns={columns}
        headerRef={headerRef}
        followEnabled={sort === null}
        matchedIds={matchedIds}
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
