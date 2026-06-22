import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { HistoryEntry } from "../types";

/** The slice of the `useHistory` hook the toolbar controls need. */
export interface HistoryModel {
  canUndo: boolean;
  canRedo: boolean;
  entries: HistoryEntry[];
  undo: () => void;
  redo: () => void;
  jump: (id: number) => void;
  refreshList: () => Promise<void> | void;
  clear: () => void;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5000) return "now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Undo/redo buttons plus a History dropdown (newest-first, current-position
 * marker, click an entry to jump to that state). Manual popover positioning
 * mirrors `ContextMenu` — reliable across the WebKitGTK / WebView2 webviews,
 * where CSS anchor positioning isn't supported.
 */
export function HistoryControls({ history }: { history: HistoryModel }) {
  const { canUndo, canRedo, entries, undo, redo, jump, refreshList, clear } = history;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    void refreshList();
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const menu = menuRef.current?.getBoundingClientRect();
    const width = menu?.width ?? 280;
    const height = menu?.height ?? 0;
    const x = Math.max(6, Math.min(anchor.right - width, window.innerWidth - width - 6));
    const y = Math.max(6, Math.min(anchor.bottom + 4, window.innerHeight - height - 6));
    setPos({ x, y });
  }, [open, entries]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  // Backend order is oldest-applied → newest-applied → undone (future). Show
  // newest first; the current state is the last applied (undone === false) entry.
  const rows = [...entries].reverse();
  const applied = entries.filter((entry) => !entry.undone);
  const current = applied[applied.length - 1];
  const undoLabel = current?.label;
  const redoLabel = entries.find((entry) => entry.undone)?.label;
  const currentId = current?.id ?? null;

  return (
    <div className="tb-group history-group" role="group" aria-label="History">
      <button
        className="btn ghost icon"
        onClick={undo}
        disabled={!canUndo}
        title={canUndo ? `Undo: ${undoLabel ?? ""}` : "Nothing to undo"}
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        className="btn ghost icon"
        onClick={redo}
        disabled={!canRedo}
        title={canRedo ? `Redo: ${redoLabel ?? ""}` : "Nothing to redo"}
        aria-label="Redo"
      >
        ↷
      </button>
      <button
        ref={triggerRef}
        className={`btn ghost ${open ? "active" : ""}`}
        onClick={toggle}
        title="History — click an entry to jump to that state"
        aria-expanded={open}
      >
        History ▾
      </button>

      {open && (
        <div ref={menuRef} className="ctx-menu history-menu" style={{ left: pos.x, top: pos.y }}>
          {rows.length === 0 ? (
            <div className="history-empty">Nothing to undo yet</div>
          ) : (
            rows.map((entry) => (
              <button
                key={entry.id}
                className={[
                  "history-item",
                  entry.undone ? "undone" : "applied",
                  entry.id === currentId ? "current" : "",
                  entry.kind,
                ].join(" ")}
                onClick={() => jump(entry.id)}
                title={`${entry.label} — jump here`}
              >
                <span className="history-icon">{entry.kind === "traffic" ? "🗑" : "✎"}</span>
                <span className="history-label">{entry.label}</span>
                <span className="history-time">
                  {entry.id === currentId ? "now ◂" : relativeTime(entry.timestampMs)}
                </span>
              </button>
            ))
          )}
          {rows.length > 0 && (
            <>
              <div className="history-sep" />
              <button
                className="history-item clear"
                onClick={() => {
                  clear();
                  setOpen(false);
                }}
              >
                Clear history
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
