import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FlowSummary } from "../types";
import { FLEX_PREFERENCE, type ColumnDef } from "../columns";

interface Props {
  flows: FlowSummary[];
  columns: ColumnDef[];
  matchedIds: Set<string> | null;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onContentWidth?: (w: number) => void;
  onCommentEdit: (id: string, comment: string | null) => void;
}

const MIN_W = 38;
const STORE_KEY = "germi.colWidths";
const GAP = 8;
const ROW_PAD = 20;
const FLEX_MIN = 60;

function loadWidths(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    // Guard against a corrupt/legacy value (e.g. the literal "null", a number,
    // or an array) — indexing those during render would crash the whole list.
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

export function TrafficList({
  flows,
  columns,
  matchedIds,
  selectedId,
  selectedIds,
  onRowClick,
  onContentWidth,
  onCommentEdit,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<string, number>>(loadWidths);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const cancelEdit = useRef(false);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(widths));
  }, [widths]);

  const widthOf = (c: ColumnDef) => {
    const w = widths[c.id];
    // Coerce/clamp: a non-number or sub-minimum value falls back to the default
    // (otherwise a stale/negative/NaN width yields a broken CSS track).
    return typeof w === "number" && Number.isFinite(w) && w >= MIN_W ? w : c.width;
  };

  // The visible column that flexes to fill leftover width (first present wins).
  const flexId = FLEX_PREFERENCE.find((id) => columns.some((c) => c.id === id));
  const flexIndex = flexId ? columns.findIndex((c) => c.id === flexId) : -1;
  const hasFlex = flexIndex >= 0;

  const tracks = columns.map((c, i) => (i === flexIndex ? "minmax(60px, 1fr)" : `${widthOf(c)}px`));
  // With no flexible column, a trailing spacer lets columns left-pack cleanly.
  const cols = hasFlex ? tracks.join(" ") : `${tracks.join(" ")} minmax(0, 1fr)`;

  const contentWidth =
    columns.reduce((acc, c, i) => acc + (i === flexIndex ? FLEX_MIN : widthOf(c)), 0) +
    GAP * Math.max(0, columns.length - 1) +
    ROW_PAD;
  useEffect(() => {
    onContentWidth?.(contentWidth);
  }, [contentWidth, onContentWidth]);

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
      // pointercancel (touch/pen interruption, lost capture) fires INSTEAD of
      // pointerup, so clean up here too — else the move listener leaks and the
      // global cursor stays stuck on "col-resize".
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function commitComment(id: string) {
    onCommentEdit(id, draft.trim() || null);
    setEditingId(null);
  }

  const virtualizer = useVirtualizer({
    count: flows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 24,
  });

  return (
    <div className="flow-list" style={{ "--cols": cols } as CSSProperties}>
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
                onDoubleClick={() => setWidths((prev) => ({ ...prev, [c.id]: c.width }))}
                title="Drag to resize · double-click to reset"
              />
            </span>
          );
        })}
      </div>

      <div className="flow-scroll" ref={parentRef}>
        <div className="flow-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const f = flows[item.index];
            const selected = f.id === selectedId;
            const inSet = selectedIds.has(f.id);
            const matched = matchedIds !== null && matchedIds.has(f.id);
            const dimmed = matchedIds !== null && !matchedIds.has(f.id);
            return (
              <div
                key={f.id}
                className={`flow-row ${selected ? "selected" : ""} ${
                  inSet ? "checked" : ""
                } ${f.matchedRule ? "ruled" : ""} ${matched ? "match" : ""} ${dimmed ? "dim" : ""}`}
                style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                onClick={(e) => onRowClick(f.id, e)}
                title={f.matchedRule ? `rule: ${f.matchedRule}` : undefined}
              >
                {columns.map((c) => renderCell(c, f))}
              </div>
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
    </div>
  );

  function renderCell(c: ColumnDef, f: FlowSummary) {
    if (c.special === "method") {
      return (
        <span key={c.id} className={`c-method m-${f.method.toLowerCase()}`}>
          {f.method}
        </span>
      );
    }
    if (c.special === "status") {
      return (
        <span key={c.id} className={`c-status ${statusClass(f.status)}`}>
          {f.status ?? "···"}
        </span>
      );
    }
    if (c.special === "kind") {
      return (
        <span key={c.id} className="c-kind">
          {f.kind}
        </span>
      );
    }
    if (c.special === "comment") {
      const editing = editingId === f.id;
      return (
        <span
          key={c.id}
          className="c-comment"
          onClick={(e) => {
            e.stopPropagation();
            if (!editing) {
              setEditingId(f.id);
              setDraft(f.comment ?? "");
            }
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
    const txt = c.text(f);
    return (
      <span key={c.id} className={c.align === "right" ? "cell-right" : ""} title={txt || undefined}>
        {txt}
      </span>
    );
  }
}
