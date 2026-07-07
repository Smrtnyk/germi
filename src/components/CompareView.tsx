import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";

import { api } from "../ipc";
import { flowUrl } from "../flowUrl";
import { urlSimilarity } from "../urlSimilarity";
import { nextSort } from "../sort";
import { toggledSet } from "../selection";
import { handleCompareKeys, type CompareKeyActions } from "../compareKeys";
import {
  copyPaneFilter,
  linkSourceSide,
  movePaneFlows,
  paneData,
  selectAll,
  selectOnly,
  selectRow,
  stepSelection,
  visiblePaneFlows,
  type PaneColumnId,
  type PaneData,
  type PaneQuery,
  type SelectMode,
} from "../comparePane";
import { useToast, type Notify } from "../toast";
import { CompareDiff } from "./CompareDiff";
import { CompareGutter } from "./CompareGutter";
import { ComparePane, type ComparePaneProps } from "./ComparePane";
import { CaptureDropOverlay } from "./CaptureDropOverlay";
import { Button } from "./ui/Button";
import { IconArrowLeft, IconChevronRight, IconCompare, IconDiff, IconOpen } from "./icons";
import { readFileAsBase64, useCaptureDrop } from "../captureDrop";
import type { CaptureExt } from "../dnd";
import type { FlowSummary, ResourceKind } from "../types";

type Side = "left" | "right";

const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

function matchMap(list: FlowSummary[], other: FlowSummary | null): Map<string, number> | null {
  if (!other) return null;
  const target = flowUrl(other);
  return new Map(list.map((f) => [f.id, urlSimilarity(flowUrl(f), target)]));
}

function modeFromEvent(e: ReactMouseEvent): SelectMode {
  if (e.shiftKey) return "range";
  if (e.ctrlKey || e.metaKey) return "toggle";
  return "single";
}

interface PaneOps {
  click: (id: string, e: ReactMouseEvent) => void;
  step: (dir: 1 | -1, extend: boolean) => void;
  setFilter: (filter: string) => void;
  toggleKind: (kind: ResourceKind) => void;
  toggleSort: (columnId: PaneColumnId) => void;
}

/** Filter and kind edits go through `applyQuery` so linking can mirror them
 *  to the other pane; the sort stays a per-pane view preference. */
function paneOps(
  pane: PaneData,
  setPane: (p: PaneData) => void,
  visibleIds: string[],
  applyQuery: (query: PaneQuery) => void,
): PaneOps {
  return {
    click: (id, e) =>
      setPane({ ...pane, sel: selectRow(pane.sel, visibleIds, id, modeFromEvent(e)) }),
    step: (dir, extend) =>
      setPane({ ...pane, sel: stepSelection(pane.sel, visibleIds, dir, extend) }),
    setFilter: (filter) => applyQuery({ ...pane.query, filter }),
    toggleKind: (kind) => applyQuery({ ...pane.query, kinds: toggledSet(pane.query.kinds, kind) }),
    toggleSort: (columnId) =>
      setPane({ ...pane, query: { ...pane.query, sort: nextSort(pane.query.sort, columnId) } }),
  };
}

interface SideState {
  data: PaneData;
  visible: FlowSummary[];
  matches: Map<string, number> | null;
  focused: FlowSummary | null;
  ops: PaneOps;
}

/** All compare-picker state: two panes (rows / selection / query), the derived
 *  visible lists + match maps, and the cross-pane move actions. */
function useComparePanes(initialLeft: FlowSummary[], initialRight: FlowSummary[]) {
  const [left, setLeft] = useState(() => paneData(initialLeft));
  const [right, setRight] = useState(() => paneData(initialRight));
  const [activeSide, setActiveSide] = useState<Side>("left");
  const [linked, setLinked] = useState(true);
  const setters: Record<Side, Dispatch<SetStateAction<PaneData>>> = {
    left: setLeft,
    right: setRight,
  };

  const leftFocused = left.flows.find((f) => f.id === left.sel.focusedId) ?? null;
  const rightFocused = right.flows.find((f) => f.id === right.sel.focusedId) ?? null;
  const leftMatches = useMemo(() => matchMap(left.flows, rightFocused), [left.flows, rightFocused]);
  const rightMatches = useMemo(
    () => matchMap(right.flows, leftFocused),
    [right.flows, leftFocused],
  );
  const leftVisible = useMemo(
    () => visiblePaneFlows(left.flows, left.query, leftMatches),
    [left, leftMatches],
  );
  const rightVisible = useMemo(
    () => visiblePaneFlows(right.flows, right.query, rightMatches),
    [right, rightMatches],
  );

  /** Write a side's query; while linked, mirror the filter half across. */
  function applyQuery(side: Side, query: PaneQuery) {
    setters[side]((cur) => ({ ...cur, query }));
    if (linked) copyFilterTo(otherSide(side), query);
  }

  function copyFilterTo(side: Side, source: PaneQuery) {
    setters[side]((cur) => ({ ...cur, query: copyPaneFilter(source, cur.query) }));
  }

  function copyFilter(from: Side) {
    copyFilterTo(otherSide(from), from === "left" ? left.query : right.query);
  }

  /** Re-linking syncs both sides from the surviving filter (issue #88: the
   *  only filled-in side, or the left one when both are). */
  function toggleLinked() {
    if (!linked) copyFilter(linkSourceSide(left.query, right.query));
    setLinked(!linked);
  }

  const sides: Record<Side, SideState> = {
    left: {
      data: left,
      visible: leftVisible,
      matches: leftMatches,
      focused: leftFocused,
      ops: paneOps(
        left,
        setLeft,
        leftVisible.map((f) => f.id),
        (query) => applyQuery("left", query),
      ),
    },
    right: {
      data: right,
      visible: rightVisible,
      matches: rightMatches,
      focused: rightFocused,
      ops: paneOps(
        right,
        setRight,
        rightVisible.map((f) => f.id),
        (query) => applyQuery("right", query),
      ),
    },
  };

  function move(to: Side, ids: Set<string> | null) {
    const source = to === "right" ? sides.left : sides.right;
    const target = to === "right" ? sides.right : sides.left;
    const moved = movePaneFlows(
      source.data,
      target.data,
      source.visible.map((f) => f.id),
      ids,
    );
    if (!moved) return;
    if (to === "right") {
      setLeft(moved.from);
      setRight(moved.to);
    } else {
      setRight(moved.from);
      setLeft(moved.to);
    }
  }

  function rowMove(side: Side, id: string) {
    const inSelection = sides[side].data.sel.selectedIds.has(id);
    move(otherSide(side), inSelection ? null : new Set([id]));
  }

  function click(side: Side, id: string, e: ReactMouseEvent) {
    setActiveSide(side);
    sides[side].ops.click(id, e);
  }

  /** Ctrl/⌘+A: mark every visible row of the active pane (issue #104). */
  function selectAllActive() {
    const ids = sides[activeSide].visible.map((f) => f.id);
    setters[activeSide]((cur) => ({ ...cur, sel: selectAll(cur.sel, ids) }));
  }

  function appendRight(added: FlowSummary[]) {
    setRight((cur) => ({
      ...cur,
      flows: [...cur.flows, ...added],
      sel: cur.sel.focusedId === null ? selectOnly(added[0].id) : cur.sel,
    }));
  }

  return {
    sides,
    activeSide,
    linked,
    toggleLinked,
    copyFilter,
    stepActive: (dir: 1 | -1, extend: boolean) => sides[activeSide].ops.step(dir, extend),
    selectAllActive,
    moveRight: (ids: Set<string> | null = null) => move("right", ids),
    moveLeft: (ids: Set<string> | null = null) => move("left", ids),
    rowMove,
    click,
    appendRight,
  };
}

/** "Load file…": append a HAR / SAZ / .germi to the session and feed the new
 *  rows to the right pane. */
function useCompareFile(appendRight: (flows: FlowSummary[]) => void, notify: Notify) {
  const [loading, setLoading] = useState(false);

  async function ingest(load: () => Promise<FlowSummary[] | null>) {
    setLoading(true);
    try {
      const flows = await load();
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

  const loadFile = () => ingest(() => api.appendCapture());
  const loadDropped = (file: File, ext: CaptureExt) =>
    ingest(async () => api.appendDroppedCapture(await readFileAsBase64(file), ext));

  return { loading, loadFile, loadDropped };
}

function useCompareKeys(actions: CompareKeyActions): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => handleCompareKeys(e, ref.current);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
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
        <Button variant="ghost" size="small" onClick={onBack}>
          <IconArrowLeft /> Back to picker (Esc)
        </Button>
      ) : (
        <span className="muted compare-subtitle">
          pick one request on each side, then diff them
        </span>
      )}
      <div className="spacer" />
      {!diffOpen && (
        <Button
          variant="primary"
          disabled={!canDiff}
          onClick={onDiff}
          title="Diff the focused pair (Enter)"
        >
          <IconDiff /> Diff
        </Button>
      )}
      <Button variant="ghost" size="small" onClick={onClose}>
        Close (Esc)
      </Button>
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
          <kbd>↓</kbd> select · <kbd>⇧</kbd> extend · <kbd>⌃/⌘</kbd> toggle · <kbd>⌃/⌘</kbd>
          <kbd>A</kbd> all · <kbd>→</kbd>
          <kbd>←</kbd> move selection · double-click moves too · <kbd>Enter</kbd> diff ·{" "}
          <kbd>Esc</kbd> close
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
 * Content of the compare window (issue #86), a real non-modal OS window so the
 * traffic list stays visible while comparing: each pane is a filterable,
 * sortable, multi-selectable request table whose rows show how closely their
 * URL matches the other side's focused row (structural, not textual — good
 * matches get a full-row tint). Feed the right side by moving rows across or
 * loading a HAR / SAZ / .germi (appended to the session as imported rows),
 * then diff the focused pair as raw HTTP.
 */
export function CompareView({ initialLeft, initialRight, onClose }: CompareViewProps) {
  const notify = useToast();
  const panes = useComparePanes(initialLeft, initialRight);
  const [diffOpen, setDiffOpen] = useState(false);
  const file = useCompareFile(panes.appendRight, notify);
  const fileDrop = useCaptureDrop({
    onFile: file.loadDropped,
    onReject: (reason) => notify("info", reason),
    disabled: diffOpen,
  });

  const { left, right } = panes.sides;
  const canDiff = left.focused !== null && right.focused !== null;

  useCompareKeys({
    diffOpen,
    canDiff,
    openDiff: () => setDiffOpen(true),
    closeDiff: () => setDiffOpen(false),
    close: onClose,
    moveSelectedRight: () => panes.moveRight(),
    moveSelectedLeft: () => panes.moveLeft(),
    stepActive: panes.stepActive,
    selectAllActive: panes.selectAllActive,
  });

  const paneProps = (side: Side): ComparePaneProps => {
    const s = panes.sides[side];
    return {
      title: side === "left" ? "A — yours" : "B — compare against",
      emptyHint:
        side === "left"
          ? "Nothing on this side — move a request back with ←"
          : "Load a capture file, or move requests here with →",
      rows: s.visible,
      total: s.data.flows.length,
      selection: s.data.sel,
      active: panes.activeSide === side,
      matches: s.matches,
      tint: side === "left" ? "a" : "b",
      query: s.data.query,
      onFilterChange: s.ops.setFilter,
      onToggleKind: s.ops.toggleKind,
      onToggleSort: s.ops.toggleSort,
      onRowClick: (id, e) => panes.click(side, id, e),
      onRowMove: (id) => panes.rowMove(side, id),
      moveHint: side === "left" ? "move to the right side" : "move back to the left side",
    };
  };

  return (
    <div className="compare-window">
      <CompareHead
        diffOpen={diffOpen}
        canDiff={canDiff}
        onBack={() => setDiffOpen(false)}
        onDiff={() => setDiffOpen(true)}
        onClose={onClose}
      />

      {diffOpen && left.focused && right.focused ? (
        <div className="compare-content">
          <CompareDiff left={left.focused} right={right.focused} />
        </div>
      ) : (
        <div className="compare-body">
          <ComparePane {...paneProps("left")} />
          <CompareGutter
            linked={panes.linked}
            canMoveRight={left.focused !== null}
            canMoveLeft={right.focused !== null}
            onToggleLinked={panes.toggleLinked}
            onCopyFilter={panes.copyFilter}
            onMoveRight={() => panes.moveRight()}
            onMoveLeft={() => panes.moveLeft()}
          />
          <ComparePane
            {...paneProps("right")}
            actions={
              <Button
                variant="ghost"
                size="small"
                disabled={file.loading}
                onClick={() => void file.loadFile()}
              >
                <IconOpen /> Load file…
              </Button>
            }
          />
        </div>
      )}

      <CompareFoot
        diffOpen={diffOpen}
        pairMatch={
          !diffOpen && left.focused && right.focused
            ? urlSimilarity(flowUrl(left.focused), flowUrl(right.focused))
            : null
        }
      />

      <CaptureDropOverlay
        active={fileDrop.dragging}
        title="Drop to add to the comparison"
        hint=".germi, .har, or .saz — appended to side B"
      />
    </div>
  );
}
