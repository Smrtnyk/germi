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

interface Props {
  flows: FlowSummary[];
  /** Ids matching the active filter (null = no filter; nothing dimmed). */
  matchedIds: Set<string> | null;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
}

// Path is the flexible (1fr) column that absorbs every resize; the rest are
// fixed widths the user can drag. Keys match the `c-<key>` cell classes.
type ColKey = "method" | "host" | "status" | "mime" | "size" | "time";
const COLUMNS: { key: ColKey | "path"; label: string }[] = [
  { key: "method", label: "Method" },
  { key: "host", label: "Host" },
  { key: "path", label: "Path" },
  { key: "status", label: "Status" },
  { key: "mime", label: "Type" },
  { key: "size", label: "Size" },
  { key: "time", label: "ms" },
];
const DEFAULT_W: Record<ColKey, number> = {
  method: 62,
  host: 150,
  status: 52,
  mime: 116,
  size: 74,
  time: 46,
};
const MIN_W = 38;
const STORE_KEY = "germi.colWidths";
const FLEX_INDEX = COLUMNS.findIndex((c) => c.key === "path");

function loadWidths(): Record<ColKey, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return { ...DEFAULT_W, ...saved };
  } catch {
    return { ...DEFAULT_W };
  }
}

function statusClass(status: number | null): string {
  if (status === null) return "pending";
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 300) return "s3";
  return "s2";
}

function fmtSize(n: number): string {
  if (n === 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function TrafficList({
  flows,
  matchedIds,
  selectedId,
  selectedIds,
  onRowClick,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<ColKey, number>>(loadWidths);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(widths));
  }, [widths]);

  const cols = `${widths.method}px ${widths.host}px minmax(60px, 1fr) ${widths.status}px ${widths.mime}px ${widths.size}px ${widths.time}px`;

  // `sign` is +1 for columns left of the flex (Path) column — they grow as you
  // drag their right edge right — and -1 for columns to its right, whose left
  // edge tracks the cursor as the flex column absorbs the change on that side.
  function startResize(e: ReactPointerEvent, key: ColKey, sign: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";

    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W, Math.round(startW + sign * (ev.clientX - startX)));
      setWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
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
        {COLUMNS.map((c, i) => {
          if (c.key === "path") {
            return (
              <span key={c.key} className="c-path">
                {c.label}
              </span>
            );
          }
          const key = c.key as ColKey;
          const side = i < FLEX_INDEX ? "right" : "left";
          const sign = i < FLEX_INDEX ? 1 : -1;
          return (
            <span key={c.key} className={`c-${c.key}`}>
              {c.label}
              <span
                className={`col-resize ${side}`}
                onPointerDown={(e) => startResize(e, key, sign)}
                onDoubleClick={() =>
                  setWidths((prev) => ({ ...prev, [key]: DEFAULT_W[key] }))
                }
                title="Drag to resize · double-click to reset"
              />
            </span>
          );
        })}
      </div>

      <div className="flow-scroll" ref={parentRef}>
        <div
          className="flow-canvas"
          style={{ height: virtualizer.getTotalSize() }}
        >
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
                } ${f.matchedRule ? "ruled" : ""} ${matched ? "match" : ""} ${
                  dimmed ? "dim" : ""
                }`}
                style={{
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                }}
                onClick={(e) => onRowClick(f.id, e)}
                title={f.matchedRule ? `rule: ${f.matchedRule}` : undefined}
              >
                <span className={`c-method m-${f.method.toLowerCase()}`}>
                  {f.method}
                </span>
                <span className="c-host" title={f.host}>
                  {f.host}
                </span>
                <span className="c-path" title={f.path}>
                  {f.path}
                </span>
                <span className={`c-status ${statusClass(f.status)}`}>
                  {f.status ?? "···"}
                </span>
                <span className="c-mime">{f.mime ?? ""}</span>
                <span className="c-size">{fmtSize(f.respSize)}</span>
                <span className="c-time">
                  {f.durationMs !== null ? f.durationMs : ""}
                </span>
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
}
