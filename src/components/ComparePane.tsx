import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { flowUrl } from "../flowUrl";
import { statusCls } from "../filter";
import type { FlowSummary } from "../types";

/** Match badge tone: near matches read green, weak ones fade out. */
function matchTone(pct: number): string {
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

export interface ComparePaneProps {
  title: string;
  emptyHint: string;
  flows: FlowSummary[];
  selectedId: string | null;
  active: boolean;
  /** Similarity vs the other side's selection, or null when it has none. */
  matches: Map<string, number> | null;
  onSelect: (id: string) => void;
  onMove: (id: string) => void;
  moveHint: string;
  actions?: ReactNode;
}

/** One side of the compare picker (issue #86): a virtualized request list
 *  whose rows carry a URL-match badge against the other side's selection. */
export function ComparePane({
  title,
  emptyHint,
  flows,
  selectedId,
  active,
  matches,
  onSelect,
  onMove,
  moveHint,
  actions,
}: ComparePaneProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });
  return (
    <div className={active ? "compare-pane active" : "compare-pane"}>
      <div className="compare-pane-head">
        <span className="compare-pane-title">{title}</span>
        <span className="compare-count">{flows.length}</span>
        <div className="spacer" />
        {actions}
      </div>
      {flows.length === 0 ? (
        <div className="compare-empty muted">{emptyHint}</div>
      ) : (
        <div ref={parentRef} className="compare-list">
          <div className="compare-canvas" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const f = flows[item.index];
              const match = matches?.get(f.id);
              return (
                <div
                  key={f.id}
                  className={f.id === selectedId ? "compare-row selected" : "compare-row"}
                  style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                  onClick={() => onSelect(f.id)}
                  onDoubleClick={() => onMove(f.id)}
                  title={`${flowUrl(f)}\nDouble-click: ${moveHint}`}
                >
                  <span className={`badge m-${f.method.toLowerCase()}`}>{f.method}</span>
                  <span className={`multi-code ${statusCls(f.status)}`}>{f.status ?? "···"}</span>
                  <span className="compare-host">{f.host}</span>
                  <span className="compare-path">{f.path}</span>
                  {match !== undefined && (
                    <span className={`compare-match ${matchTone(match)}`}>{match}%</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
