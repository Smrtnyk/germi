import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FlowSummary } from "../types";
import { FLEX_PREFERENCE, type ColumnDef } from "../columns";
import { useToast } from "../toast";
import { ContextMenu, type MenuItem } from "./ContextMenu";

interface Props {
  flows: FlowSummary[];
  columns: ColumnDef[];
  matchedIds: Set<string> | null;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onKeySelect: (id: string, extend: boolean) => void;
  onClearSelection: () => void;
  onContentWidth?: (w: number) => void;
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
const FLEX_MIN = 60;
const BOTTOM_SLACK = 40;

function loadWidths(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
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

interface Menu {
  x: number;
  y: number;
  flow: FlowSummary;
}

interface ColumnWidths {
  widthOf: (c: ColumnDef) => number;
  resetWidth: (id: string, width: number) => void;
  startResize: (e: ReactPointerEvent, c: ColumnDef, sign: number) => void;
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

  function startResize(e: ReactPointerEvent, c: ColumnDef, sign: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W, Math.round(startW + sign * (ev.clientX - startX)));
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
): FollowTail {
  const [follow, setFollow] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevLen = useRef(flows.length);

  // Live-capture follow: stick to the newest row while following; otherwise
  // accrue a "new" count so the user can jump back without losing their place.
  useEffect(() => {
    const grew = flows.length - prevLen.current;
    if (grew > 0) {
      if (follow) virtualizer.scrollToIndex(flows.length - 1, { align: "end" });
      else setNewCount((c) => c + grew);
    } else if (flows.length < prevLen.current) {
      setNewCount(0);
    }
    prevLen.current = flows.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows.length, follow]);

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
  flexIndex: number;
  hasFlex: boolean;
  startResize: (e: ReactPointerEvent, c: ColumnDef, sign: number) => void;
  resetWidth: (id: string, width: number) => void;
}

function HeaderRow({ columns, flexIndex, hasFlex, startResize, resetWidth }: HeaderRowProps) {
  return (
    <div className="flow-row flow-head">
      {columns.map((c, i) => {
        const alignCls = c.align === "right" ? "cell-right" : "";
        if (i === flexIndex) {
          return (
            <span key={c.id} className={alignCls}>
              {c.label}
            </span>
          );
        }
        const side = hasFlex && i > flexIndex ? "left" : "right";
        const sign = hasFlex && i > flexIndex ? -1 : 1;
        return (
          <span key={c.id} className={alignCls}>
            {c.label}
            <span
              className={`col-resize ${side}`}
              onPointerDown={(e) => startResize(e, c, sign)}
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

function FlowCell({ c, f, comments }: FlowCellProps) {
  if (c.special === "method") {
    return <span className={`c-method m-${f.method.toLowerCase()}`}>{f.method}</span>;
  }
  if (c.special === "status") {
    return <span className={`c-status ${statusClass(f.status)}`}>{f.status ?? "···"}</span>;
  }
  if (c.special === "kind") {
    return <span className="c-kind">{f.kind}</span>;
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

function CommentCell({ f, comments }: CommentCellProps) {
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
            e.stopPropagation();
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
}: FlowRowProps) {
  return (
    <div
      className={`flow-row ${selected ? "selected" : ""} ${inSet ? "checked" : ""} ${
        f.matchedRule ? "ruled" : ""
      } ${matched ? "match" : ""} ${dimmed ? "dim" : ""}`}
      style={{ transform: `translateY(${item.start}px)`, height: item.size }}
      onClick={(e) => {
        onRowClick(f.id, e);
        onActivate();
      }}
      onContextMenu={(e) => onOpenMenu(e, f)}
      title={f.matchedRule ? `mocked by rule: ${f.matchedRule}` : undefined}
    >
      {columns.map((c) => (
        <FlowCell key={c.id} c={c} f={f} comments={comments} />
      ))}
    </div>
  );
}

interface ColumnLayout {
  flexIndex: number;
  hasFlex: boolean;
  cols: string;
}

function useColumnLayout(
  columns: ColumnDef[],
  widthOf: (c: ColumnDef) => number,
  onContentWidth?: (w: number) => void,
): ColumnLayout {
  const flexId = FLEX_PREFERENCE.find((id) => columns.some((c) => c.id === id));
  const flexIndex = flexId ? columns.findIndex((c) => c.id === flexId) : -1;
  const hasFlex = flexIndex >= 0;

  const tracks = columns.map((c, i) => (i === flexIndex ? "minmax(60px, 1fr)" : `${widthOf(c)}px`));
  const cols = hasFlex ? tracks.join(" ") : `${tracks.join(" ")} minmax(0, 1fr)`;

  const contentWidth =
    columns.reduce((acc, c, i) => acc + (i === flexIndex ? FLEX_MIN : widthOf(c)), 0) +
    GAP * Math.max(0, columns.length - 1) +
    ROW_PAD;
  useEffect(() => {
    onContentWidth?.(contentWidth);
  }, [contentWidth, onContentWidth]);

  return { flexIndex, hasFlex, cols };
}

interface MenuActions {
  beginEdit: (f: FlowSummary) => void;
  onMockFlow: (id: string) => void;
  onFilterToHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onCopyCurl: (id: string) => void;
  onCopyBody: (id: string) => void;
}

function urlOf(f: FlowSummary): string {
  return `${f.scheme}://${f.host}${f.path}`;
}

function menuItemsFor(
  f: FlowSummary,
  a: MenuActions,
  notify: ReturnType<typeof useToast>,
): MenuItem[] {
  return [
    { label: "⚡ Mock this", onClick: () => a.onMockFlow(f.id) },
    { label: "Add note", onClick: () => a.beginEdit(f) },
    { label: "", sep: true, onClick: () => {} },
    {
      label: "Copy URL",
      onClick: () => {
        void navigator.clipboard.writeText(urlOf(f));
        notify("success", "URL copied");
      },
    },
    { label: "Copy as cURL", onClick: () => a.onCopyCurl(f.id) },
    { label: "Copy body", onClick: () => a.onCopyBody(f.id) },
    { label: "", sep: true, onClick: () => {} },
    { label: `Filter to host: ${f.host}`, onClick: () => a.onFilterToHost(f.host) },
    { label: `Exclude host: ${f.host}`, onClick: () => a.onExcludeHost(f.host), danger: true },
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
      items={menuItemsFor(menu.flow, actions, notify)}
      onClose={() => setMenu(null)}
    />
  ) : null;

  return { openMenu, menuEl };
}

interface FlowScrollProps {
  flows: FlowSummary[];
  columns: ColumnDef[];
  matchedIds: Set<string> | null;
  selectedId: string | null;
  selectedIds: Set<string>;
  comments: CommentDraft;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onKeySelect: (id: string, extend: boolean) => void;
  onClearSelection: () => void;
  onOpenMenu: (e: ReactMouseEvent, f: FlowSummary) => void;
}

function FlowScroll({
  flows,
  columns,
  matchedIds,
  selectedId,
  selectedIds,
  comments,
  onRowClick,
  onKeySelect,
  onClearSelection,
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
  );

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
      default:
        return;
    }
    e.preventDefault();
    stopFollowing();
    const id = flows[next].id;
    onKeySelect(id, e.shiftKey);
    virtualizer.scrollToIndex(next, { align: "auto" });
  }

  return (
    <>
      <div
        className="flow-scroll"
        ref={parentRef}
        tabIndex={0}
        onKeyDown={moveSelection}
        onScroll={onScroll}
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

      {!follow && newCount > 0 && (
        <button
          className="follow-pill"
          onClick={jumpToLatest}
          title="Jump to newest and resume tailing"
        >
          {newCount} new ↓
        </button>
      )}
    </>
  );
}

export function TrafficList({
  flows,
  columns,
  matchedIds,
  selectedId,
  selectedIds,
  onRowClick,
  onKeySelect,
  onClearSelection,
  onContentWidth,
  onCommentEdit,
  onMockFlow,
  onFilterToHost,
  onExcludeHost,
  onCopyCurl,
  onCopyBody,
}: Props) {
  const { widthOf, resetWidth, startResize } = useColumnWidths();
  const comments = useCommentDraft(onCommentEdit);
  const { flexIndex, hasFlex, cols } = useColumnLayout(columns, widthOf, onContentWidth);
  const { openMenu, menuEl } = useFlowMenu(selectedId, selectedIds, onKeySelect, {
    beginEdit: comments.beginEdit,
    onMockFlow,
    onFilterToHost,
    onExcludeHost,
    onCopyCurl,
    onCopyBody,
  });

  return (
    <div className="flow-list" style={{ "--cols": cols } as CSSProperties}>
      <HeaderRow
        columns={columns}
        flexIndex={flexIndex}
        hasFlex={hasFlex}
        startResize={startResize}
        resetWidth={resetWidth}
      />

      <FlowScroll
        flows={flows}
        columns={columns}
        matchedIds={matchedIds}
        selectedId={selectedId}
        selectedIds={selectedIds}
        comments={comments}
        onRowClick={onRowClick}
        onKeySelect={onKeySelect}
        onClearSelection={onClearSelection}
        onOpenMenu={openMenu}
      />

      {menuEl}
    </div>
  );
}
