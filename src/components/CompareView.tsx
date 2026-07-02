import { useMemo, useState, type KeyboardEvent } from "react";

import { api } from "../ipc";
import { flowUrl } from "../flowUrl";
import { urlSimilarity } from "../urlSimilarity";
import { useToast, type Notify } from "../toast";
import { useModalDialog } from "./useModalDialog";
import { CompareDiff } from "./CompareDiff";
import { ComparePane } from "./ComparePane";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronRight,
  IconCompare,
  IconDiff,
  IconOpen,
} from "./icons";
import type { FlowSummary } from "../types";

type Side = "left" | "right";

function matchMap(list: FlowSummary[], other: FlowSummary | null): Map<string, number> | null {
  if (!other) return null;
  const target = flowUrl(other);
  return new Map(list.map((f) => [f.id, urlSimilarity(flowUrl(f), target)]));
}

/** Remove `id` from `list`, suggesting the neighbor to select next. */
function without(
  list: FlowSummary[],
  id: string,
): { rest: FlowSummary[]; item: FlowSummary; nextSel: string | null } | null {
  const index = list.findIndex((f) => f.id === id);
  if (index === -1) return null;
  const rest = list.filter((f) => f.id !== id);
  return { rest, item: list[index], nextSel: rest[Math.min(index, rest.length - 1)]?.id ?? null };
}

function step(list: FlowSummary[], selected: string | null, dir: 1 | -1): string | null {
  if (list.length === 0) return null;
  const index = list.findIndex((f) => f.id === selected);
  if (index === -1) return list[dir === 1 ? 0 : list.length - 1].id;
  return list[Math.min(list.length - 1, Math.max(0, index + dir))].id;
}

interface PaneState {
  flows: FlowSummary[];
  selected: string | null;
}

function usePanes(initialLeft: FlowSummary[], initialRight: FlowSummary[]) {
  const [left, setLeft] = useState<PaneState>({
    flows: initialLeft,
    selected: initialLeft[0]?.id ?? null,
  });
  const [right, setRight] = useState<PaneState>({
    flows: initialRight,
    selected: initialRight[0]?.id ?? null,
  });

  function move(
    from: PaneState,
    setFrom: (p: PaneState) => void,
    to: PaneState,
    setTo: (p: PaneState) => void,
    id: string | null,
  ) {
    if (id === null) return;
    const gone = without(from.flows, id);
    if (!gone) return;
    setFrom({ flows: gone.rest, selected: gone.nextSel });
    setTo({ flows: [...to.flows, gone.item], selected: gone.item.id });
  }

  return {
    left,
    right,
    setLeft,
    setRight,
    appendRight: (added: FlowSummary[]) =>
      setRight((cur) => ({
        flows: [...cur.flows, ...added],
        selected: cur.selected ?? added[0].id,
      })),
    moveRight: (id: string | null) => move(left, setLeft, right, setRight, id),
    moveLeft: (id: string | null) => move(right, setRight, left, setLeft, id),
  };
}

/** "Load file…": append a HAR / SAZ / .germi to the session and feed the new
 *  rows to the right pane. */
function useCompareFile(appendRight: (flows: FlowSummary[]) => void, notify: Notify) {
  const [loading, setLoading] = useState(false);

  async function loadFile() {
    setLoading(true);
    try {
      const flows = await api.appendCapture();
      if (flows === null) return;
      if (flows.length === 0) {
        notify("info", "The file contained no requests");
        return;
      }
      appendRight(flows);
      notify(
        "success",
        `Loaded ${flows.length} request${flows.length === 1 ? "" : "s"} to compare against`,
      );
    } catch (e) {
      notify("error", String(e));
    } finally {
      setLoading(false);
    }
  }

  return { loading, loadFile };
}

interface CompareKeyActions {
  diffOpen: boolean;
  canDiff: boolean;
  openDiff: () => void;
  closeDiff: () => void;
  moveSelectedRight: () => void;
  moveSelectedLeft: () => void;
  stepActive: (dir: 1 | -1) => void;
}

function handleCompareKeys(e: KeyboardEvent<HTMLDialogElement>, ctx: CompareKeyActions): void {
  if (e.key === "Escape") {
    if (ctx.diffOpen) {
      e.preventDefault();
      ctx.closeDiff();
    }
    return;
  }
  if (ctx.diffOpen) return;
  if (e.key === "Enter") {
    if (ctx.canDiff && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      ctx.openDiff();
    }
    return;
  }
  const nav: Record<string, () => void> = {
    ArrowUp: () => ctx.stepActive(-1),
    ArrowDown: () => ctx.stepActive(1),
    ArrowRight: ctx.moveSelectedRight,
    ArrowLeft: ctx.moveSelectedLeft,
  };
  const run = nav[e.key];
  if (run) {
    e.preventDefault();
    run();
  }
}

function CompareHead({
  diffOpen,
  canDiff,
  onBack,
  onDiff,
  onClose,
}: {
  diffOpen: boolean;
  canDiff: boolean;
  onBack: () => void;
  onDiff: () => void;
  onClose: () => void;
}) {
  return (
    <div className="compare-head">
      <IconCompare />
      <span className="compare-title">Compare requests</span>
      {diffOpen ? (
        <button className="btn ghost small" onClick={onBack}>
          <IconArrowLeft /> Back to picker (Esc)
        </button>
      ) : (
        <span className="muted compare-subtitle">
          pick one request on each side, then diff them
        </span>
      )}
      <div className="spacer" />
      {!diffOpen && (
        <button
          className="btn primary"
          disabled={!canDiff}
          onClick={onDiff}
          title="Diff the selected pair (Enter)"
        >
          <IconDiff /> Diff
        </button>
      )}
      <button className="btn ghost small" onClick={onClose}>
        Close (Esc)
      </button>
    </div>
  );
}

function CompareFoot({ diffOpen, pairMatch }: { diffOpen: boolean; pairMatch: number | null }) {
  return (
    <div className="compare-foot muted">
      {diffOpen ? (
        <>
          <kbd>B</kbd> show/hide both bodies · <kbd>Esc</kbd> back
        </>
      ) : (
        <>
          <kbd>↑</kbd>
          <kbd>↓</kbd> select · <kbd>→</kbd>
          <kbd>←</kbd> move across · double-click moves too · <kbd>Enter</kbd> diff · <kbd>Esc</kbd>{" "}
          close
        </>
      )}
      {!diffOpen && pairMatch !== null && (
        <span className="compare-pair">
          <IconChevronRight /> {pairMatch}% URL match
        </span>
      )}
    </div>
  );
}

export interface CompareViewProps {
  initialLeft: FlowSummary[];
  initialRight: FlowSummary[];
  onClose: () => void;
}

/**
 * The compare window (issue #86): pick a request on each side — the opposite
 * side shows how closely each row's URL matches (structural, not textual) —
 * then diff the two as raw HTTP. The right side is fed by moving rows across
 * or by loading a HAR / SAZ / .germi file (appended to the session, so the
 * loaded requests also appear in the traffic list as imported rows).
 */
export function CompareView({ initialLeft, initialRight, onClose }: CompareViewProps) {
  const notify = useToast();
  const ref = useModalDialog(onClose);
  const panes = usePanes(initialLeft, initialRight);
  const file = useCompareFile(panes.appendRight, notify);
  const [activeSide, setActiveSide] = useState<Side>("left");
  const [diffOpen, setDiffOpen] = useState(false);

  const { left, right } = panes;
  const leftFlow = left.flows.find((f) => f.id === left.selected) ?? null;
  const rightFlow = right.flows.find((f) => f.id === right.selected) ?? null;
  const leftMatches = useMemo(() => matchMap(left.flows, rightFlow), [left.flows, rightFlow]);
  const rightMatches = useMemo(() => matchMap(right.flows, leftFlow), [right.flows, leftFlow]);
  const canDiff = leftFlow !== null && rightFlow !== null;

  function select(side: Side, id: string) {
    setActiveSide(side);
    if (side === "left") panes.setLeft({ ...left, selected: id });
    else panes.setRight({ ...right, selected: id });
  }

  function stepActive(dir: 1 | -1) {
    const pane = activeSide === "left" ? left : right;
    const next = step(pane.flows, pane.selected, dir);
    if (next !== null) select(activeSide, next);
  }

  const keyActions: CompareKeyActions = {
    diffOpen,
    canDiff,
    openDiff: () => setDiffOpen(true),
    closeDiff: () => setDiffOpen(false),
    moveSelectedRight: () => panes.moveRight(left.selected),
    moveSelectedLeft: () => panes.moveLeft(right.selected),
    stepActive,
  };

  return (
    <dialog
      ref={ref}
      className="maximize-dialog compare-dialog"
      onKeyDown={(e) => handleCompareKeys(e, keyActions)}
      aria-label="Compare requests"
    >
      <CompareHead
        diffOpen={diffOpen}
        canDiff={canDiff}
        onBack={() => setDiffOpen(false)}
        onDiff={() => setDiffOpen(true)}
        onClose={() => ref.current?.close()}
      />

      {diffOpen && leftFlow && rightFlow ? (
        <div className="compare-content">
          <CompareDiff left={leftFlow} right={rightFlow} />
        </div>
      ) : (
        <div className="compare-body">
          <ComparePane
            title="A — yours"
            emptyHint="Nothing on this side — move a request back with ←"
            flows={left.flows}
            selectedId={left.selected}
            active={activeSide === "left"}
            matches={leftMatches}
            onSelect={(id) => select("left", id)}
            onMove={(id) => panes.moveRight(id)}
            moveHint="move to the right side"
          />
          <div className="compare-gutter">
            <button
              className="btn ghost"
              disabled={left.selected === null}
              onClick={() => panes.moveRight(left.selected)}
              title="Move the selected request to the right side (→)"
            >
              <IconArrowRight />
            </button>
            <button
              className="btn ghost"
              disabled={right.selected === null}
              onClick={() => panes.moveLeft(right.selected)}
              title="Move the selected request back to the left side (←)"
            >
              <IconArrowLeft />
            </button>
          </div>
          <ComparePane
            title="B — compare against"
            emptyHint="Load a capture file, or move requests here with →"
            flows={right.flows}
            selectedId={right.selected}
            active={activeSide === "right"}
            matches={rightMatches}
            onSelect={(id) => select("right", id)}
            onMove={(id) => panes.moveLeft(id)}
            moveHint="move back to the left side"
            actions={
              <button
                className="btn ghost small"
                disabled={file.loading}
                onClick={() => void file.loadFile()}
              >
                <IconOpen /> Load file…
              </button>
            }
          />
        </div>
      )}

      <CompareFoot
        diffOpen={diffOpen}
        pairMatch={
          !diffOpen && leftFlow && rightFlow
            ? urlSimilarity(flowUrl(leftFlow), flowUrl(rightFlow))
            : null
        }
      />
    </dialog>
  );
}
