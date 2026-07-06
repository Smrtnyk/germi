import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { debounce, isEqual } from "es-toolkit";

import { api } from "../ipc";
import { GENERAL_SCENARIO_ID } from "../types";
import { ruleLabel } from "../autoresponderState";
import { clickSelection, pruneSelection } from "../selection";
import { decodeFlowIds, FLOW_DRAG_MIME, hasFlowDrag, RULE_DRAG_MIME } from "../dnd";
import type {
  Action,
  ActionKind,
  AutoResponderSummary,
  BulkMockEvent,
  HistoryTag,
  Rule,
  RuleSearchScope,
  RuleSummary,
  ScenarioSummary,
} from "../types";
import { isShallowScope, ruleMatchesScopeClient } from "../ruleScope";
import { ruleRowParts, type RuleRowParts } from "../ruleRow";
import type { AutoLayout } from "../appState";
import { useResizable } from "../useResizable";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconExternal,
  IconGeneral,
  IconGrip,
  IconMaximize,
  IconMock,
  IconPanelCollapse,
  IconPanelExpand,
  IconPower,
  IconWarn,
} from "./icons";
import { MaximizedOverlay } from "./MaximizedOverlay";
import { RuleTester } from "./RuleTester";
import { Tooltip } from "./Tooltip";

// Lazy-loaded so CodeMirror (and its language packs) is a separate chunk fetched
// only when a mock body is actually edited — keeps app startup light.
const BodyEditor = lazy(() => import("./BodyEditor").then((m) => ({ default: m.BodyEditor })));

const COLLAPSE_KEY = "germi.ruleDetailCollapsed";

/** Persisted "is the rule detail pane collapsed" toggle (issue #72, feature D). */
function useDetailCollapsed(): [boolean, (fn: (c: boolean) => boolean) => void] {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = (fn: (c: boolean) => boolean) =>
    setCollapsedState((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore quota / privacy-mode errors */
      }
      return next;
    });
  return [collapsed, setCollapsed];
}

interface ScenarioActions {
  activate: (scenarioId: string | null) => void;
  setGeneralActive: (active: boolean) => void;
  create: () => Promise<ScenarioSummary | null>;
  rename: (scenarioId: string, name: string) => void;
  delete: (scenarioId: string) => void;
  resetState: (scenarioId: string | null) => void;
}

interface RuleActions {
  create: (scenarioId: string) => Promise<RuleSummary | null>;
  load: (ruleId: string) => Promise<Rule | null>;
  update: (scenarioId: string, rule: Rule, tag?: HistoryTag) => Promise<RuleSummary | null>;
  delete: (scenarioId: string, ruleId: string) => void;
  deleteMany: (scenarioId: string, ruleIds: string[]) => void;
  duplicate: (scenarioId: string, ruleId: string) => Promise<RuleSummary | null>;
  reorder: (scenarioId: string, ruleId: string, toId: string) => void;
}

interface TransferActions {
  exportRules: (scenarioId: string | null) => void;
  importRules: (replace: boolean) => void;
  dropMock: (ids: string[], scenarioId: string | null) => void;
}

export interface AutoresponderPanelProps {
  ar: AutoResponderSummary;
  scenarioActions: ScenarioActions;
  ruleActions: RuleActions;
  transferActions: TransferActions;
  /** When set (e.g. via "Mock this"), select this rule for editing. */
  selectRuleId?: string | null;
  ruleHits: Record<string, number>;
  bulkMockProgress: BulkMockEvent | null;
  /** Bumped on every undo/redo so the open rule re-fetches its reverted value. */
  reloadToken?: number;
  /** Where the rule detail sits relative to the list (Settings → Autoresponder). */
  layout: AutoLayout;
  /** Rule ids currently open in a detached editor window. */
  openWindowRuleIds: Set<string>;
  /** Open (or focus) a rule's detached editor window. */
  onOpenRuleWindow: (ruleId: string) => void;
}

const ACTION_KINDS: { value: ActionKind; label: string }[] = [
  { value: "respond", label: "Auto-respond (mock)" },
  { value: "mapLocal", label: "Map local file" },
  { value: "setResponseHeader", label: "Set response header" },
  { value: "cors", label: "Allow CORS" },
  { value: "rewriteResponseBody", label: "Rewrite response body" },
  { value: "setStatus", label: "Set status code" },
  { value: "setRequestHeader", label: "Set request header" },
  { value: "block", label: "Block request" },
];

function defaultAction(kind: ActionKind): Action {
  switch (kind) {
    case "respond":
      return {
        kind: "respond",
        status: 200,
        headers: [],
        body: '{\n  "mocked": true\n}',
        contentType: "application/json",
        contentEncoding: null,
      };
    case "mapLocal":
      return { kind: "mapLocal", path: "", status: 200 };
    case "block":
      return { kind: "block" };
    case "setRequestHeader":
      return { kind: "setRequestHeader", name: "", value: "" };
    case "setResponseHeader":
      return { kind: "setResponseHeader", name: "", value: "" };
    case "setStatus":
      return { kind: "setStatus", status: 200 };
    case "rewriteResponseBody":
      return { kind: "rewriteResponseBody", find: "", replace: "", regex: false };
    case "cors":
      return { kind: "cors" };
  }
}

function fireBadge(rule: RuleSummary): string | null {
  if (rule.fireLimit === null) return null;
  if (rule.repeat) return "loop";
  return rule.fireLimit === 1 ? "once" : `x${rule.fireLimit}`;
}

/** Non-blocking lint of a rule — surfaced as inline warnings in the editor so
 *  silently-never-matching or duplicate-header mistakes are caught early. */
function ruleWarnings(rule: Rule): string[] {
  const w: string[] = [];
  if (!rule.matcher.url.trim()) {
    w.push("URL pattern is empty — this rule matches every request.");
  } else if (rule.matcher.urlMatch === "regex") {
    // The engine compiles with the Rust `regex` crate, whose dialect differs from
    // JS. Normalize Rust-style named groups ((?P<n>…)) before the JS validity
    // check so they don't false-warn, and flag lookaround/backreferences — valid
    // JS but unsupported by Rust, so the rule would look fine here yet never match.
    const pat = rule.matcher.url;
    try {
      RegExp(pat.replace(/\(\?P</g, "(?<"));
      if (/\(\?<?[=!]|\\[1-9]/.test(pat)) {
        w.push(
          "URL regex uses lookaround/backreferences, which the engine doesn't support — this rule will never match.",
        );
      }
    } catch {
      w.push("URL regex is invalid — this rule will never match.");
    }
  }
  if (rule.action.kind === "cors" && rule.matcher.method) {
    w.push(
      "A method-specific matcher splits Allow CORS in half — preflights are OPTIONS while the stamped responses are GET/POST etc. Clear Method to cover both.",
    );
  }
  if (rule.action.kind === "respond") {
    const names = rule.action.headers.map(([n]) => n.trim().toLowerCase()).filter(Boolean);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) w.push(`Duplicate header "${dup}" — only the last value is sent.`);
    if (names.includes("content-type")) {
      w.push("Content-Type is in the Headers table — use the dedicated field to avoid duplicates.");
    }
    if (names.includes("content-encoding")) {
      w.push(
        "Content-Encoding is in the Headers table — use the dedicated toggle below to avoid duplicates.",
      );
    }
  }
  return w;
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rsection ${open ? "open" : ""}`}>
      <button
        type="button"
        className="rsection-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rsection-caret">{open ? <IconChevronDown /> : <IconChevronRight />}</span>
        {title}
      </button>
      {open && <div className="rsection-body">{children}</div>}
    </div>
  );
}

interface RuleDragCallbacks {
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/** The native drag/drop handlers for a rule row — extracted so the guards don't
 *  inflate the row component's complexity; flow drags (drop-to-mock) are ignored
 *  here so only rule-reorder drags are handled. */
function ruleDragProps(rule: RuleSummary, draggable: boolean, cb: RuleDragCallbacks) {
  return {
    draggable,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.setData(RULE_DRAG_MIME, rule.id);
      e.dataTransfer.effectAllowed = "move";
      cb.onDragStart();
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!draggable || hasFlowDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      cb.onDragOver();
    },
    onDrop: (e: ReactDragEvent) => {
      if (hasFlowDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      cb.onDrop();
    },
    onDragEnd: cb.onDragEnd,
  };
}

/** The two text lines of a compact row: host/path on top (the rule's identity,
 *  since rules have no name — issue #74), the action summary below. A disabled
 *  rule strikes through the URL, matching the old name treatment. */
function ruleRowLines(
  parts: RuleRowParts,
  enabled: boolean,
): { primary: ReactNode; secondary: ReactNode } {
  return {
    primary: <RulePattern host={parts.host} path={parts.path} off={enabled ? "" : "off"} />,
    secondary: <span className="raction">{parts.action}</span>,
  };
}

function RuleRowMarkers({
  rule,
  hits,
  poppedOut,
}: {
  rule: RuleSummary;
  hits: number;
  poppedOut: boolean;
}) {
  const badge = fireBadge(rule);
  return (
    <>
      {poppedOut && (
        <span className="rpop" title="Open in a separate window">
          <IconExternal />
        </span>
      )}
      {badge && (
        <span className="rfire">
          {badge}
          {rule.fireLimit !== null && ` ${hits}/${rule.fireLimit}`}
        </span>
      )}
    </>
  );
}

function ruleItemClass(s: {
  selected: boolean;
  checked: boolean;
  dragOver: boolean;
  poppedOut: boolean;
}): string {
  const flags = [
    s.selected && "selected",
    s.checked && "checked",
    s.dragOver && "dragover",
    s.poppedOut && "poppedout",
  ].filter(Boolean);
  return `rule-item ${flags.join(" ")}`;
}

/** A compact traffic-list-style row: method badge + host/path (never the URL
 *  twice), a small action line, and the fire/popped-out markers (issue #72). */
export function RuleListItem({
  rule,
  selected,
  checked,
  poppedOut,
  hits,
  draggable,
  dragOver,
  onSelect,
  onOpen,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  rule: RuleSummary;
  /** The single active row whose editor is open (dominant highlight). */
  selected: boolean;
  /** A member of a multi-selection (lighter highlight). */
  checked?: boolean;
  poppedOut: boolean;
  hits: number;
  draggable: boolean;
  dragOver: boolean;
  onSelect: (event: ReactMouseEvent) => void;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const parts = ruleRowParts(rule);
  const { primary, secondary } = ruleRowLines(parts, rule.enabled);
  const label = ruleLabel(rule.matcher.url);
  const cls = ruleItemClass({ selected, checked: !!checked, dragOver, poppedOut });
  return (
    <div
      className={cls}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        // Stop shift-click from painting a text selection across rows.
        if (e.shiftKey) e.preventDefault();
      }}
      title={`${label}\nDouble-click to open in a separate window`}
      {...ruleDragProps(rule, draggable, { onDragStart, onDragOver, onDrop, onDragEnd })}
    >
      {draggable && (
        <span className="rgrip" title="Drag to reorder (evaluation order matters)">
          <IconGrip />
        </span>
      )}
      <input
        type="checkbox"
        checked={rule.enabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <div className="rmeta">
        <div className="rtop">
          <span className={`rmethod ${parts.methodClass ?? ""}`}>{parts.method}</span>
          {primary}
          <div className="spacer" />
          <RuleRowMarkers rule={rule} hits={hits} poppedOut={poppedOut} />
        </div>
        <div className="rsub">{secondary}</div>
      </div>
    </div>
  );
}

function RulePattern({ host, path, off }: { host: string; path: string; off: string }) {
  return (
    <span className={`rurl ${off}`}>
      {host && <span className="rhost">{host}</span>}
      <span className="rpath">{path || (host ? "/" : "*")}</span>
    </span>
  );
}

type SaveState = "idle" | "saving" | "saved";

export function useSelectedRule(
  scenarioId: string,
  selectedRuleId: string | null,
  onLoadRule: (ruleId: string) => Promise<Rule | null>,
  onUpdateRule: (scenarioId: string, rule: Rule, tag?: HistoryTag) => Promise<RuleSummary | null>,
  reloadToken?: number,
) {
  const [rule, setRule] = useState<Rule | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<number | null>(null);
  const pendingRule = useRef<Rule | null>(null);
  const loadGeneration = useRef(0);
  const loadRuleRef = useRef(onLoadRule);
  const updateRuleRef = useRef(onUpdateRule);
  loadRuleRef.current = onLoadRule;
  updateRuleRef.current = onUpdateRule;
  const prevDeps = useRef({ scenarioId, selectedRuleId, reloadToken });

  useEffect(() => {
    const prev = prevDeps.current;
    // An external reload = same rule/scenario but a bumped reloadToken (undo/redo,
    // a cross-window edit). It supersedes any un-flushed pending edit, so we must
    // NOT re-commit that edit over the reverted state (which made undo a no-op).
    const externalReload =
      prev.scenarioId === scenarioId &&
      prev.selectedRuleId === selectedRuleId &&
      prev.reloadToken !== reloadToken;
    prevDeps.current = { scenarioId, selectedRuleId, reloadToken };
    const generation = ++loadGeneration.current;
    if (!selectedRuleId) {
      setRule(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const load = async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const pending = pendingRule.current;
      pendingRule.current = null;
      if (pending && !externalReload) await updateRuleRef.current(scenarioId, pending);
      return loadRuleRef.current(selectedRuleId);
    };
    void load().then((loaded) => {
      if (loadGeneration.current === generation) {
        setRule(loaded);
        setLoading(false);
        setSaveState("idle");
      }
    });
  }, [scenarioId, selectedRuleId, reloadToken]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const pending = pendingRule.current;
      if (pending) void updateRuleRef.current(scenarioId, pending);
    };
  }, [scenarioId]);

  function patch(changes: Partial<Rule>, tag?: HistoryTag) {
    if (!rule) return;
    const next = { ...rule, ...changes };
    setRule(next);
    setSaveState("saving");
    if (tag) {
      void commitDiscrete(next, tag);
      return;
    }
    pendingRule.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const pending = pendingRule.current;
      pendingRule.current = null;
      saveTimer.current = null;
      if (!pending) return;
      void updateRuleRef.current(scenarioId, pending).then((summary) => {
        if (summary) setSaveState("saved");
      });
    }, 300);
  }

  // Seal any pending typing as its own (rule-keyed) step, then record `next`
  // under its own history key — so e.g. Format is a separate, single undo entry
  // instead of folding into the surrounding edits.
  async function commitDiscrete(next: Rule, tag: HistoryTag) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = pendingRule.current;
    pendingRule.current = null;
    if (pending) await updateRuleRef.current(scenarioId, pending);
    const summary = await updateRuleRef.current(scenarioId, next, tag);
    if (summary) setSaveState("saved");
  }

  function clearPending() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingRule.current = null;
  }

  async function flush() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = pendingRule.current;
    pendingRule.current = null;
    if (pending) await updateRuleRef.current(scenarioId, pending);
  }

  return { rule, loading, saveState, patch, clearPending, flush };
}

/** Rule-list selection (issue #106). `selectedRuleId` is the single "active" row
 *  whose editor is open; `selectedIds` is the multi-selection for bulk delete.
 *  The active id is always a member of the set (or both are empty), so the editor
 *  shows exactly when `selectedIds.size <= 1`. Click semantics reuse the shared,
 *  tested pure helpers (`rangeSelection` / `toggleSelection`); the ordered id list
 *  (the currently shown, filtered rules) is passed in at call time. */
export function useRuleSelection(selectRuleId?: string | null) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<RuleSearchScope>("all");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const selectOne = useCallback((id: string | null) => {
    setSelectedRuleId(id);
    setSelectedIds(id ? new Set([id]) : new Set());
    anchorRef.current = id;
  }, []);

  useEffect(() => {
    if (selectRuleId) selectOne(selectRuleId);
  }, [selectRuleId, selectOne]);

  function onRowClick(order: string[], id: string, e: ReactMouseEvent) {
    const patch = clickSelection(order, selectedIds, selectedRuleId, anchorRef.current, id, e);
    setSelectedIds(patch.selectedIds);
    setSelectedRuleId(patch.selectedId);
    anchorRef.current = patch.anchor;
  }

  function selectAll(order: string[]) {
    if (order.length === 0) return;
    setSelectedIds(new Set(order));
    setSelectedRuleId(order[order.length - 1]);
    anchorRef.current = order[0];
  }

  const clearSelection = useCallback(() => selectOne(null), [selectOne]);

  /** Keep the selection scoped to the rows the user can currently see: drop ids
   *  that were filtered out, deleted here, or removed from a detached window, and
   *  re-home the active row / anchor onto a surviving member (issue #106). Bulk
   *  Delete and the "N selected" count then never include invisible rows. Reads
   *  the current state, so it must NOT be memoized. */
  function retainVisible(presentOrder: string[]) {
    const patch = pruneSelection(presentOrder, selectedIds, selectedRuleId, anchorRef.current);
    if (!patch) return;
    setSelectedIds(patch.selectedIds);
    setSelectedRuleId(patch.selectedId);
    anchorRef.current = patch.anchor;
  }

  const ensureSelected = useCallback(
    (id: string) => {
      if (!selectedIds.has(id)) selectOne(id);
    },
    [selectedIds, selectOne],
  );

  return {
    selectedIds,
    selectedRuleId,
    selectOne,
    onRowClick,
    selectAll,
    clearSelection,
    retainVisible,
    ensureSelected,
    query,
    setQuery,
    scope,
    setScope,
    dragId,
    setDragId,
    overId,
    setOverId,
  };
}

function useDeepRuleSearch(
  scenarioId: string,
  query: string,
  scope: RuleSearchScope,
): Set<string> | null {
  const [result, setResult] = useState<{ scenario: string; ids: Set<string> } | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (isShallowScope(scope) || q === "") {
      setResult(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void api
        .searchRules(scenarioId, q, scope)
        .then((ids) => {
          if (!cancelled) setResult({ scenario: scenarioId, ids: new Set(ids) });
        })
        .catch(() => {
          if (!cancelled) setResult(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [scenarioId, q, scope]);

  return result && result.scenario === scenarioId ? result.ids : null;
}

function filterRulesByScope(
  rules: RuleSummary[],
  query: string,
  scope: RuleSearchScope,
  deepIds: Set<string> | null,
): RuleSummary[] {
  const q = query.trim();
  if (q === "") return rules;
  if (isShallowScope(scope)) {
    return rules.filter((r) => ruleMatchesScopeClient(r, scope, q));
  }
  if (deepIds === null) return rules;
  return rules.filter((r) => deepIds.has(r.id));
}

interface FlowDropZone {
  onDragOver: (e: ReactDragEvent) => void;
  onDragLeave: (e: ReactDragEvent) => void;
  onDrop: (e: ReactDragEvent) => void;
}

interface FlowDrop {
  zone: string | null;
  zoneProps: (zone: string, scenarioId: string | null | (() => string)) => FlowDropZone;
}

function useFlowDrop(onDropMock: (ids: string[], scenarioId: string | null) => void): FlowDrop {
  const [zone, setZone] = useState<string | null>(null);

  function over(e: ReactDragEvent, z: string) {
    if (!hasFlowDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setZone((cur) => (cur === z ? cur : z));
  }
  function leave(e: ReactDragEvent, z: string) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setZone((cur) => (cur === z ? null : cur));
    }
  }
  function drop(e: ReactDragEvent, scenarioId: string | null) {
    if (!hasFlowDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    setZone(null);
    const ids = decodeFlowIds(e.dataTransfer.getData(FLOW_DRAG_MIME));
    if (ids.length > 0) onDropMock(ids, scenarioId);
  }

  function zoneProps(z: string, scenarioId: string | null | (() => string)): FlowDropZone {
    return {
      onDragOver: (e) => over(e, z),
      onDragLeave: (e) => leave(e, z),
      onDrop: (e) => drop(e, typeof scenarioId === "function" ? scenarioId() : scenarioId),
    };
  }

  return { zone, zoneProps };
}

interface RuleMenuActions {
  onMoveToTop: (id: string) => void;
  onMoveToBottom: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onDeleteSelected: () => void;
}

function ruleMenuItems(
  rule: RuleSummary,
  canReorder: boolean,
  actions: RuleMenuActions,
  selectedCount: number,
): MenuItem[] {
  // With several rules selected the single-rule actions (move/duplicate/toggle)
  // don't apply — offer only the bulk delete so the menu can't lie about scope.
  if (selectedCount > 1) {
    return [
      {
        label: `Delete ${selectedCount} rules`,
        onClick: () => actions.onDeleteSelected(),
        danger: true,
      },
    ];
  }
  const items: MenuItem[] = [];
  if (canReorder) {
    items.push(
      { label: "Move to top", onClick: () => actions.onMoveToTop(rule.id) },
      { label: "Move to bottom", onClick: () => actions.onMoveToBottom(rule.id) },
      { label: "", sep: true, onClick: () => {} },
    );
  }
  items.push(
    { label: "Duplicate rule", onClick: () => actions.onDuplicate(rule.id) },
    {
      label: rule.enabled ? "Disable rule" : "Enable rule",
      onClick: () => actions.onToggle(rule.id, !rule.enabled),
    },
    { label: "", sep: true, onClick: () => {} },
    { label: "Delete rule", onClick: () => actions.onDelete(rule.id), danger: true },
  );
  return items;
}

function useRuleMenu(
  canReorder: boolean,
  actions: RuleMenuActions,
  selection: { selectedIds: Set<string>; ensureSelected: (id: string) => void },
): {
  openMenu: (event: ReactMouseEvent, rule: RuleSummary) => void;
  menuElement: ReactElement | null;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; rule: RuleSummary } | null>(null);
  function openMenu(event: ReactMouseEvent, rule: RuleSummary) {
    event.preventDefault();
    event.stopPropagation();
    // Right-clicking a row outside the current selection acts on just that row.
    selection.ensureSelected(rule.id);
    setMenu({ x: event.clientX, y: event.clientY, rule });
  }
  // The count reflects the selection as of the click (ensureSelected collapses an
  // outside-click to 1); a right-click inside a multi-selection keeps it.
  const count = menu
    ? selection.selectedIds.has(menu.rule.id)
      ? selection.selectedIds.size
      : 1
    : 0;
  const menuElement = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={ruleMenuItems(menu.rule, canReorder, actions, count)}
      onClose={() => setMenu(null)}
    />
  ) : null;
  return { openMenu, menuElement };
}

export interface RuleListBehavior {
  selectedRuleId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, event: ReactMouseEvent) => void;
  ensureSelected: (id: string) => void;
  onSelectAll: () => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
  openWindowRuleIds: Set<string>;
  onOpen: (id: string) => void;
  canReorder: boolean;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  overId: string | null;
  setOverId: (id: string | null) => void;
  ruleHits: Record<string, number>;
  onToggle: (id: string, enabled: boolean) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveToTop: (id: string) => void;
  onMoveToBottom: (id: string) => void;
  onReorder: (toId: string) => void;
}

const RULE_SCOPES: { value: RuleSearchScope; label: string }[] = [
  { value: "url", label: "URL" },
  { value: "method", label: "Method" },
  { value: "status", label: "Status" },
  { value: "response", label: "Response" },
  { value: "headers", label: "Headers" },
  { value: "all", label: "All" },
];

function RuleListToolbar({
  query,
  setQuery,
  scope,
  setScope,
  onAdd,
}: {
  query: string;
  setQuery: (q: string) => void;
  scope: RuleSearchScope;
  setScope: (s: RuleSearchScope) => void;
  onAdd: () => void;
}) {
  return (
    <>
      <button className="btn primary block" onClick={onAdd}>
        + Add rule
      </button>
      <div className="rule-search-row">
        <input
          className="rule-search"
          placeholder="Search rules…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="rule-search-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as RuleSearchScope)}
          title="Which rule fields to search"
        >
          {RULE_SCOPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function RuleListMessage({
  ruleCount,
  shownCount,
  query,
}: {
  ruleCount: number;
  shownCount: number;
  query: string;
}) {
  if (ruleCount === 0) return <div className="muted pad">No rules in this scenario yet.</div>;
  if (shownCount === 0) {
    return <div className="muted pad small">No rules match “{query}”.</div>;
  }
  return null;
}

function RuleList({
  rules,
  shownRules,
  query,
  setQuery,
  scope,
  setScope,
  onAdd,
  behavior,
}: {
  rules: RuleSummary[];
  shownRules: RuleSummary[];
  query: string;
  setQuery: (q: string) => void;
  scope: RuleSearchScope;
  setScope: (s: RuleSearchScope) => void;
  onAdd: () => void;
  behavior: RuleListBehavior;
}) {
  return (
    <aside className="rule-list">
      <RuleListToolbar
        query={query}
        setQuery={setQuery}
        scope={scope}
        setScope={setScope}
        onAdd={onAdd}
      />
      <RuleListMessage ruleCount={rules.length} shownCount={shownRules.length} query={query} />
      <VirtualRuleList rules={shownRules} behavior={behavior} />
    </aside>
  );
}

/** Ctrl/⌘+A, Delete and Escape act on the focused rule list (issue #106).
 *  stopPropagation shields them from the window-level shortcut handler, which
 *  would otherwise route Ctrl+A to the traffic list's select-all. */
function handleRuleListKeys(
  e: ReactKeyboardEvent,
  b: Pick<
    RuleListBehavior,
    "selectedIds" | "onSelectAll" | "onDeleteSelected" | "onClearSelection"
  >,
): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    e.stopPropagation();
    b.onSelectAll();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (b.selectedIds.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    b.onDeleteSelected();
  } else if (e.key === "Escape" && b.selectedIds.size > 0) {
    e.preventDefault();
    b.onClearSelection();
  }
}

export function VirtualRuleList({
  rules,
  behavior,
}: {
  rules: RuleSummary[];
  behavior: RuleListBehavior;
}) {
  const {
    selectedRuleId,
    selectedIds,
    onRowClick,
    ensureSelected,
    onSelectAll,
    onDeleteSelected,
    onClearSelection,
    openWindowRuleIds,
    onOpen,
    canReorder,
    dragId,
    setDragId,
    overId,
    setOverId,
    ruleHits,
    onToggle,
    onDuplicate,
    onDelete,
    onMoveToTop,
    onMoveToBottom,
    onReorder,
  } = behavior;
  const { openMenu, menuElement } = useRuleMenu(
    canReorder,
    { onMoveToTop, onMoveToBottom, onDuplicate, onToggle, onDelete, onDeleteSelected },
    { selectedIds, ensureSelected },
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const single = selectedIds.size <= 1;
  const selectedIndex = rules.findIndex((rule) => rule.id === selectedRuleId);
  const virtualizer = useVirtualizer({
    count: rules.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rules[index].id,
    estimateSize: () => 44,
    overscan: 8,
  });

  useEffect(() => {
    if (selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="rule-list-viewport"
      tabIndex={0}
      role="listbox"
      aria-multiselectable
      onKeyDown={(e) =>
        handleRuleListKeys(e, { selectedIds, onSelectAll, onDeleteSelected, onClearSelection })
      }
    >
      <div className="rule-list-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const rule = rules[item.index];
          return (
            <div
              key={rule.id}
              className="rule-item-slot"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <RuleListItem
                rule={rule}
                selected={single && rule.id === selectedRuleId}
                checked={selectedIds.has(rule.id)}
                poppedOut={openWindowRuleIds.has(rule.id)}
                hits={ruleHits[rule.id] ?? 0}
                draggable={canReorder}
                dragOver={overId === rule.id && dragId !== rule.id}
                onSelect={(event) => {
                  onRowClick(rule.id, event);
                  scrollRef.current?.focus({ preventScroll: true });
                }}
                onOpen={() => onOpen(rule.id)}
                onToggle={(enabled) => onToggle(rule.id, enabled)}
                onContextMenu={(event) => openMenu(event, rule)}
                onDragStart={() => setDragId(rule.id)}
                onDragOver={() => setOverId(rule.id)}
                onDrop={() => {
                  onReorder(rule.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
              />
            </div>
          );
        })}
      </div>
      {menuElement}
    </div>
  );
}

interface RuleEditorPaneProps {
  scenarioId: string;
  selectedRule: Rule | null;
  /** Size of the multi-selection; > 1 disables editing and shows the bulk panel. */
  selectedCount: number;
  loading: boolean;
  ruleHits: Record<string, number>;
  poppedOut: boolean;
  layout: AutoLayout;
  onOpen: (id: string) => void;
  onCollapse: () => void;
  onPatchRule: (p: Partial<Rule>, tag?: HistoryTag) => void;
  onDeleteRule: (id: string) => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
}

function RuleDetailHead({
  selectedRule,
  selectedCount,
  layout,
  onOpen,
  onCollapse,
}: Pick<
  RuleEditorPaneProps,
  "selectedRule" | "selectedCount" | "layout" | "onOpen" | "onCollapse"
>) {
  const collapseTitle =
    layout === "stacked" ? "Collapse details (hide below)" : "Collapse details (hide on the right)";
  const title =
    selectedCount > 1
      ? `${selectedCount} rules selected`
      : selectedRule
        ? ruleLabel(selectedRule.matcher.url)
        : "Details";
  return (
    <div className="rule-detail-head">
      <span className="rule-detail-title">{title}</span>
      <div className="spacer" />
      {selectedRule && selectedCount <= 1 && (
        <button
          className="btn ghost small"
          title="Open this rule in a separate window"
          onClick={() => onOpen(selectedRule.id)}
        >
          <IconExternal />
        </button>
      )}
      <button className="btn ghost small" title={collapseTitle} onClick={onCollapse}>
        <IconPanelCollapse />
      </button>
    </div>
  );
}

function RuleLockedNotice({ ruleId, onOpen }: { ruleId: string; onOpen: (id: string) => void }) {
  return (
    <div className="rule-locked muted pad">
      <IconExternal />
      <p>This rule is open in a separate window. Close that window to edit it here.</p>
      <button className="btn small" onClick={() => onOpen(ruleId)}>
        Focus window
      </button>
    </div>
  );
}

/** Shown in the detail pane while several rules are selected: editing a single
 *  rule doesn't apply, so offer the bulk action (delete) instead (issue #106). */
export function RuleBulkSelection({
  count,
  onDelete,
  onClear,
}: {
  count: number;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rule-detail-body">
      <div className="rule-bulk pad">
        <p className="rule-bulk-count">{count} rules selected</p>
        <p className="muted small">
          Editing is disabled while multiple rules are selected. Ctrl/⌘-click or Shift-click to
          adjust the selection, Del to delete, or Esc to clear.
        </p>
        <div className="row">
          <button className="btn danger" onClick={onDelete}>
            Delete {count} rules
          </button>
          <button className="btn" onClick={onClear}>
            Clear selection
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleDetailBody({
  scenarioId,
  selectedRule,
  loading,
  ruleHits,
  locked,
  onOpen,
  onPatchRule,
  onDeleteRule,
}: Omit<
  RuleEditorPaneProps,
  "layout" | "onCollapse" | "poppedOut" | "selectedCount" | "onDeleteSelected" | "onClearSelection"
> & { locked: boolean }) {
  if (locked && selectedRule) {
    return (
      <div className="rule-detail-body">
        <RuleLockedNotice ruleId={selectedRule.id} onOpen={onOpen} />
      </div>
    );
  }
  return (
    <div className="rule-detail-body">
      {selectedRule ? (
        <RuleEditor
          key={selectedRule.id}
          rule={selectedRule}
          hits={ruleHits[selectedRule.id] ?? 0}
          onPatch={onPatchRule}
          onDelete={() => onDeleteRule(selectedRule.id)}
        />
      ) : (
        <div className="muted pad">
          {loading ? "Loading rule…" : "Select a rule to edit it, or add one."}
        </div>
      )}
      <RuleTester
        scenarioId={scenarioId}
        seedMethod={selectedRule?.matcher.method ?? undefined}
        seedUrl={selectedRule?.matcher.url || undefined}
      />
    </div>
  );
}

function RuleEditorPane(props: RuleEditorPaneProps) {
  const { selectedRule, selectedCount, layout, poppedOut, onOpen, onCollapse } = props;
  const locked = !!selectedRule && poppedOut;
  return (
    <section className="rule-editor">
      <RuleDetailHead
        selectedRule={selectedRule}
        selectedCount={selectedCount}
        layout={layout}
        onOpen={onOpen}
        onCollapse={onCollapse}
      />
      {selectedCount > 1 ? (
        <RuleBulkSelection
          count={selectedCount}
          onDelete={props.onDeleteSelected}
          onClear={props.onClearSelection}
        />
      ) : (
        <RuleDetailBody
          scenarioId={props.scenarioId}
          selectedRule={selectedRule}
          loading={props.loading}
          ruleHits={props.ruleHits}
          locked={locked}
          onOpen={onOpen}
          onPatchRule={props.onPatchRule}
          onDeleteRule={props.onDeleteRule}
        />
      )}
    </section>
  );
}

/** The collapsed detail pane: a thin rail with an expand affordance, mirroring
 *  the app-level PanelRail but scoped to the autoresponder list/detail split. */
function RuleDetailRail({ layout, onExpand }: { layout: AutoLayout; onExpand: () => void }) {
  return (
    <div className={`rule-detail-rail ${layout}`}>
      <button className="rail-btn" onClick={onExpand} title="Show rule details">
        <IconPanelExpand />
        <span className="rail-label">Details</span>
      </button>
    </div>
  );
}

function useScenarioName(
  scenario: ScenarioSummary,
  onRenameScenario: (scenarioId: string, name: string) => void,
) {
  const [name, setName] = useState(scenario.name);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const renameRef = useRef(onRenameScenario);
  renameRef.current = onRenameScenario;

  const save = useMemo(
    () =>
      debounce((id: string, next: string) => {
        renameRef.current(id, next);
        setSaveState("saved");
      }, 300),
    [],
  );

  useEffect(() => {
    setName(scenario.name);
    setSaveState("idle");
  }, [scenario.id, scenario.name]);

  useEffect(() => () => save.flush(), [scenario.id, save]);

  function change(next: string) {
    setName(next);
    setSaveState("saving");
    save(scenario.id, next);
  }

  function flush() {
    save.flush();
  }

  return { name, change, saveState, flush };
}

function useScenarioWorkspace(
  active: ScenarioSummary,
  selectRuleId: string | null | undefined,
  ruleActions: RuleActions,
  openWindowRuleIds: Set<string>,
  reloadToken?: number,
) {
  const selection = useRuleSelection(selectRuleId);
  const selectedId = selection.selectedRuleId;
  // Editing is disabled while several rules are selected (issue #106): feed the
  // editor a null id so it neither loads nor saves against the multi-selection.
  const editingRuleId = selection.selectedIds.size <= 1 ? selectedId : null;
  const selectedPopped = editingRuleId ? openWindowRuleIds.has(editingRuleId) : false;

  // When the selected rule's detached window closes, the inline copy loaded here
  // is stale (the window saved a newer version). Bump a reload nonce on that
  // pop→unpop transition so the inline editor re-fetches instead of showing —
  // and then letting a follow-up edit overwrite — the old body.
  const [externalReload, setExternalReload] = useState(0);
  const prevPoppedRef = useRef(selectedPopped);
  useEffect(() => {
    if (prevPoppedRef.current && !selectedPopped) setExternalReload((n) => n + 1);
    prevPoppedRef.current = selectedPopped;
  }, [selectedPopped]);

  const editor = useSelectedRule(
    active.id,
    editingRuleId,
    ruleActions.load,
    ruleActions.update,
    (reloadToken ?? 0) + externalReload,
  );

  // The editing rule was genuinely deleted (here or from its detached window):
  // discard its pending debounced edit so it can't save against a dead id. A
  // filter merely *hiding* the rule is NOT a deletion — active.rules is unchanged
  // there — so the pending edit still flushes normally.
  useEffect(() => {
    if (selectedId !== null && !active.rules.some((r) => r.id === selectedId)) {
      editor.clearPending();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.rules, selectedId]);

  const rulesRef = useRef<HTMLDivElement>(null);
  // Side (left/right) sizes the list WIDTH; stacked (top/bottom) sizes the list
  // HEIGHT. Two independent resizers so a persisted width isn't reused as a
  // height (or vice-versa) when the orientation is switched.
  const listResize = useResizable({
    initial: 240,
    min: 170,
    getMax: () => (rulesRef.current?.clientWidth ?? 700) - 280,
    storageKey: "germi.ruleListWidth",
  });
  const listResizeV = useResizable({
    initial: 220,
    min: 120,
    getMax: () => (rulesRef.current?.clientHeight ?? 600) - 200,
    storageKey: "germi.ruleListHeight",
    axis: "y",
  });

  const deepIds = useDeepRuleSearch(active.id, selection.query, selection.scope);
  const shownRules = useMemo(
    () => filterRulesByScope(active.rules, selection.query, selection.scope, deepIds),
    [active.rules, selection.query, selection.scope, deepIds],
  );

  // Selection follows visibility (issue #106, mirroring the traffic list's issue
  // #90 rule): whenever the shown set changes — a filter hid rows, or rules were
  // deleted — drop the now-invisible rows from the selection and re-home the
  // active row, so bulk Delete and the "N selected" count only ever act on rows
  // the user can actually see.
  useEffect(() => {
    selection.retainVisible(shownRules.map((r) => r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRules]);

  async function addRule() {
    const created = await ruleActions.create(active.id);
    if (created) selection.selectOne(created.id);
  }

  async function toggleRule(id: string, enabled: boolean) {
    // If the rule is open in a detached window its inline copy here is locked and
    // stale; toggling via editor.patch would save that stale body and clobber the
    // window's edits. Apply the toggle to a fresh backend copy in that case.
    if (editor.rule?.id === id && !openWindowRuleIds.has(id)) {
      editor.patch({ enabled });
      return;
    }
    const rule = await ruleActions.load(id);
    if (rule) await ruleActions.update(active.id, { ...rule, enabled });
  }

  async function duplicateRule(id: string) {
    if (editor.rule?.id === id) await editor.flush();
    const created = await ruleActions.duplicate(active.id, id);
    if (created) selection.selectOne(created.id);
  }

  function deleteRule(id: string) {
    if (selection.selectedRuleId === id) {
      editor.clearPending();
      selection.selectOne(null);
    }
    ruleActions.delete(active.id, id);
  }

  function deleteSelected() {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    // Cancel any in-flight debounced save for a rule about to vanish, then clear
    // the selection before the delete so the editor can't flash a dead rule.
    editor.clearPending();
    selection.clearSelection();
    ruleActions.deleteMany(active.id, ids);
  }

  return {
    selection,
    editor,
    rulesRef,
    listResize,
    listResizeV,
    shownRules,
    addRule,
    toggleRule,
    duplicateRule,
    deleteRule,
    deleteSelected,
  };
}

type ScenarioWorkspace = ReturnType<typeof useScenarioWorkspace>;
type ScenarioNameEditor = ReturnType<typeof useScenarioName>;

function ScenarioSaveStatus({
  active,
  nameSaveState,
  ruleSaveState,
}: {
  active: ScenarioSummary;
  nameSaveState: SaveState;
  ruleSaveState: SaveState;
}) {
  const saving = nameSaveState === "saving" || ruleSaveState === "saving";
  const saved = nameSaveState === "saved" || ruleSaveState === "saved";
  return (
    <span className="muted small scenario-status">
      {active.rules.filter((rule) => rule.enabled).length}/{active.rules.length} active
      {saving && <span className="save-state"> · saving…</span>}
      {saved && (
        <span className="save-state ok">
          {" "}
          · saved <IconCheck />
        </span>
      )}
    </span>
  );
}

function GeneralScenarioHeader({
  active,
  generalActive,
  onToggleGeneral,
  ruleSaveState,
  onExport,
  onReset,
}: {
  active: ScenarioSummary;
  generalActive: boolean;
  onToggleGeneral: () => void;
  ruleSaveState: SaveState;
  onExport: () => void;
  onReset: () => void;
}) {
  return (
    <div className="scenario-head">
      <span className="scenario-name general-name" title="Built-in layer — cannot be renamed">
        <IconGeneral /> {active.name}
        <span className={`general-badge ${generalActive ? "on" : "off"}`}>
          {generalActive ? "stacking" : "off"}
        </span>
      </span>
      <ScenarioSaveStatus active={active} nameSaveState="idle" ruleSaveState={ruleSaveState} />
      <div className="scenario-actions">
        <button className="btn" title="Clear per-rule hit counters." onClick={onReset}>
          Reset state
        </button>
        <button
          className="btn"
          title="Export the General rules to a shareable .germi-rules file"
          onClick={onExport}
        >
          Export rules
        </button>
        <button
          className={`btn ${generalActive ? "" : "primary"}`}
          onClick={onToggleGeneral}
          title="Turn the General layer on or off — its rules stack on top of the active scenario when on"
        >
          <IconPower /> {generalActive ? "Turn off" : "Turn on"}
        </button>
      </div>
    </div>
  );
}

function ScenarioViewHeader({
  active,
  isGeneral,
  generalActive,
  onToggleGeneral,
  nameEditor,
  ruleSaveState,
  onExport,
  onReset,
  onRequestDelete,
}: {
  active: ScenarioSummary;
  isGeneral: boolean;
  generalActive: boolean;
  onToggleGeneral: () => void;
  nameEditor: ScenarioNameEditor;
  ruleSaveState: SaveState;
  onExport: () => void;
  onReset: () => void;
  onRequestDelete: () => void;
}) {
  if (isGeneral) {
    return (
      <GeneralScenarioHeader
        active={active}
        generalActive={generalActive}
        onToggleGeneral={onToggleGeneral}
        ruleSaveState={ruleSaveState}
        onExport={onExport}
        onReset={onReset}
      />
    );
  }
  return (
    <ScenarioHeader
      active={active}
      nameEditor={nameEditor}
      ruleSaveState={ruleSaveState}
      actions={{ reset: onReset, export: onExport, requestDelete: onRequestDelete }}
    />
  );
}

function ScenarioHeader({
  active,
  nameEditor,
  ruleSaveState,
  actions,
}: {
  active: ScenarioSummary;
  nameEditor: ScenarioNameEditor;
  ruleSaveState: SaveState;
  actions: { reset: () => void; export: () => void; requestDelete: () => void };
}) {
  return (
    <div className="scenario-head">
      <input
        className="scenario-name"
        value={nameEditor.name}
        onChange={(e) => nameEditor.change(e.target.value)}
      />
      <ScenarioSaveStatus
        active={active}
        nameSaveState={nameEditor.saveState}
        ruleSaveState={ruleSaveState}
      />
      <div className="scenario-actions">
        <button
          className="btn"
          title="Clear per-rule hit counters so match-once / sequenced rules fire from the start again."
          onClick={actions.reset}
        >
          Reset state
        </button>
        <button
          className="btn"
          title="Export this scenario to a shareable .germi-rules file"
          onClick={actions.export}
        >
          Export scenario
        </button>
        <button className="btn danger" onClick={actions.requestDelete}>
          Delete scenario
        </button>
      </div>
    </div>
  );
}

function workspaceGrid(
  layout: AutoLayout,
  collapsed: boolean,
  widthPx: number,
  heightPx: number,
): { gridTemplateColumns?: string; gridTemplateRows?: string } {
  if (layout === "stacked") {
    return {
      gridTemplateColumns: "1fr",
      gridTemplateRows: collapsed
        ? "minmax(0, 1fr) 34px"
        : `minmax(0, ${heightPx}px) 6px minmax(160px, 1fr)`,
    };
  }
  return {
    gridTemplateColumns: collapsed
      ? "minmax(0, 1fr) 34px"
      : `minmax(0, ${widthPx}px) 6px minmax(280px, 1fr)`,
  };
}

function ScenarioRuleWorkspace({
  active,
  workspace,
  ruleHits,
  ruleActions,
  layout,
  collapsed,
  onToggleCollapse,
  openWindowRuleIds,
  onOpenRuleWindow,
}: {
  active: ScenarioSummary;
  workspace: ScenarioWorkspace;
  ruleHits: Record<string, number>;
  ruleActions: RuleActions;
  layout: AutoLayout;
  collapsed: boolean;
  onToggleCollapse: () => void;
  openWindowRuleIds: Set<string>;
  onOpenRuleWindow: (ruleId: string) => void;
}) {
  const { selection, editor, listResize, listResizeV } = workspace;
  // Shift/Ctrl-click select operates over the currently shown (filtered) rows.
  const shownIds = workspace.shownRules.map((r) => r.id);
  // Flush the inline editor's pending debounced edit before popping a rule out,
  // so the detached window loads the just-typed value rather than a stale one.
  const openWindow = (ruleId: string) => {
    if (editor.rule?.id === ruleId) void editor.flush().then(() => onOpenRuleWindow(ruleId));
    else onOpenRuleWindow(ruleId);
  };
  const behavior: RuleListBehavior = {
    selectedRuleId: selection.selectedRuleId,
    selectedIds: selection.selectedIds,
    onRowClick: (id, event) => selection.onRowClick(shownIds, id, event),
    ensureSelected: selection.ensureSelected,
    onSelectAll: () => selection.selectAll(shownIds),
    onDeleteSelected: workspace.deleteSelected,
    onClearSelection: selection.clearSelection,
    openWindowRuleIds,
    onOpen: openWindow,
    canReorder: !selection.query.trim(),
    dragId: selection.dragId,
    setDragId: selection.setDragId,
    overId: selection.overId,
    setOverId: selection.setOverId,
    ruleHits,
    onToggle: (id, enabled) => void workspace.toggleRule(id, enabled),
    onDuplicate: (id) => void workspace.duplicateRule(id),
    onDelete: workspace.deleteRule,
    onMoveToTop: (id) => {
      const first = active.rules[0];
      if (first && first.id !== id) ruleActions.reorder(active.id, id, first.id);
    },
    onMoveToBottom: (id) => {
      const last = active.rules[active.rules.length - 1];
      if (last && last.id !== id) ruleActions.reorder(active.id, id, last.id);
    },
    onReorder: (toId) => {
      if (selection.dragId) ruleActions.reorder(active.id, selection.dragId, toId);
    },
  };
  const resize = layout === "stacked" ? listResizeV : listResize;

  return (
    <div
      className={`rules ${layout} ${collapsed ? "collapsed" : ""}`}
      ref={workspace.rulesRef}
      style={workspaceGrid(layout, collapsed, listResize.size, listResizeV.size)}
    >
      <RuleList
        rules={active.rules}
        shownRules={workspace.shownRules}
        query={selection.query}
        setQuery={selection.setQuery}
        scope={selection.scope}
        setScope={selection.setScope}
        onAdd={() => void workspace.addRule()}
        behavior={behavior}
      />

      {collapsed ? (
        <RuleDetailRail layout={layout} onExpand={onToggleCollapse} />
      ) : (
        <>
          <div
            className={layout === "stacked" ? "resizer-v" : "resizer"}
            onPointerDown={resize.onPointerDown}
            title="Drag to resize"
          />

          <RuleEditorPane
            scenarioId={active.id}
            selectedRule={editor.rule}
            selectedCount={selection.selectedIds.size}
            loading={editor.loading}
            ruleHits={ruleHits}
            poppedOut={editor.rule ? openWindowRuleIds.has(editor.rule.id) : false}
            layout={layout}
            onOpen={openWindow}
            onCollapse={onToggleCollapse}
            onPatchRule={editor.patch}
            onDeleteRule={workspace.deleteRule}
            onDeleteSelected={workspace.deleteSelected}
            onClearSelection={selection.clearSelection}
          />
        </>
      )}
    </div>
  );
}

function ScenarioView({
  active,
  isGeneral,
  generalActive,
  onToggleGeneral,
  onRequestDelete,
  selectRuleId,
  reloadToken,
  ruleHits,
  drop,
  scenarioActions,
  ruleActions,
  onExport,
  layout,
  collapsed,
  onToggleCollapse,
  openWindowRuleIds,
  onOpenRuleWindow,
}: {
  active: ScenarioSummary;
  isGeneral: boolean;
  generalActive: boolean;
  onToggleGeneral: () => void;
  onRequestDelete: () => void;
  selectRuleId?: string | null;
  reloadToken?: number;
  ruleHits: Record<string, number>;
  drop: { active: boolean; props: FlowDropZone };
  scenarioActions: ScenarioActions;
  ruleActions: RuleActions;
  onExport: () => void;
  layout: AutoLayout;
  collapsed: boolean;
  onToggleCollapse: () => void;
  openWindowRuleIds: Set<string>;
  onOpenRuleWindow: (ruleId: string) => void;
}) {
  const workspace = useScenarioWorkspace(
    active,
    selectRuleId,
    ruleActions,
    openWindowRuleIds,
    reloadToken,
  );
  // The General layer is not renamable; `rename` is never called for it.
  const nameEditor = useScenarioName(active, scenarioActions.rename);
  const exportScenario = () => {
    nameEditor.flush();
    void workspace.editor.flush().then(onExport);
  };
  const resetState = () => scenarioActions.resetState(active.id);

  return (
    <div className={`scenario-body ${drop.active ? "drop-target" : ""}`} {...drop.props}>
      <ScenarioViewHeader
        active={active}
        isGeneral={isGeneral}
        generalActive={generalActive}
        onToggleGeneral={onToggleGeneral}
        nameEditor={nameEditor}
        ruleSaveState={workspace.editor.saveState}
        onExport={exportScenario}
        onReset={resetState}
        onRequestDelete={onRequestDelete}
      />
      <ScenarioRuleWorkspace
        active={active}
        workspace={workspace}
        ruleHits={ruleHits}
        ruleActions={ruleActions}
        layout={layout}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        openWindowRuleIds={openWindowRuleIds}
        onOpenRuleWindow={onOpenRuleWindow}
      />
    </div>
  );
}

function GeneralTab({
  scenario,
  generalActive,
  selected,
  dropTarget,
  dropProps,
  onSelect,
  onToggle,
}: {
  scenario: ScenarioSummary;
  generalActive: boolean;
  selected: boolean;
  dropTarget: boolean;
  dropProps: FlowDropZone;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={`stab general ${selected ? "active" : ""} ${generalActive ? "" : "layer-off"} ${
        dropTarget ? "drop-target" : ""
      }`}
      {...dropProps}
    >
      <button
        type="button"
        className="stab-label"
        onClick={onSelect}
        title="Built-in rules that stack on top of whichever scenario is active — the home for cross-cutting rules like CORS headers. Drop requests here to mock them into the General layer."
      >
        <IconGeneral /> {scenario.name}
        {generalActive && <span className="live-dot" />}
      </button>
      <button
        type="button"
        className={`stab-toggle ${generalActive ? "on" : ""}`}
        onClick={onToggle}
        aria-pressed={generalActive}
        title={
          generalActive
            ? "General rules are on — click to stop applying them"
            : "General rules are off — click to apply them alongside the active scenario"
        }
      >
        <IconPower />
      </button>
    </div>
  );
}

function ScenarioTabs({
  ar,
  zone,
  zoneProps,
  viewedId,
  onSelectView,
  onActivate,
  onToggleGeneral,
  onAdd,
  onImport,
  onReplace,
  onExportAll,
}: {
  ar: AutoResponderSummary;
  zone: string | null;
  zoneProps: FlowDrop["zoneProps"];
  viewedId: string | null;
  onSelectView: (id: string) => void;
  onActivate: (id: string | null) => void;
  onToggleGeneral: (active: boolean) => void;
  onAdd: () => void;
  onImport: () => void;
  onReplace: () => void;
  onExportAll: () => void;
}) {
  const general = ar.scenarios.find((s) => s.id === GENERAL_SCENARIO_ID);
  const userScenarios = ar.scenarios.filter((s) => s.id !== GENERAL_SCENARIO_ID);
  return (
    <div className="scenario-tabs">
      {general && (
        <GeneralTab
          scenario={general}
          generalActive={ar.generalActive}
          selected={viewedId === GENERAL_SCENARIO_ID}
          dropTarget={zone === GENERAL_SCENARIO_ID}
          dropProps={zoneProps(GENERAL_SCENARIO_ID, GENERAL_SCENARIO_ID)}
          onSelect={() => onSelectView(GENERAL_SCENARIO_ID)}
          onToggle={() => onToggleGeneral(!ar.generalActive)}
        />
      )}
      {userScenarios.map((s) => (
        <button
          key={s.id}
          className={`stab ${s.id === viewedId ? "active" : ""} ${
            zone === s.id ? "drop-target" : ""
          }`}
          onClick={() => onActivate(s.id)}
          {...zoneProps(s.id, s.id)}
        >
          {s.name}
          {s.id === ar.activeScenarioId && <span className="live-dot" />}
        </button>
      ))}
      <button
        className={`stab add ${zone === "__new__" ? "drop-target" : ""}`}
        onClick={onAdd}
        title="New scenario — or drop requests here to mock them into a new one"
        {...zoneProps("__new__", () => crypto.randomUUID())}
      >
        +
      </button>
      <div className="spacer" />
      <button
        className={`stab off ${ar.activeScenarioId === null ? "active" : ""}`}
        onClick={() => onActivate(null)}
        title="Disable mocking — capture only"
      >
        <IconPower /> Off
      </button>
      <button
        className="btn small"
        title="Import scenarios from a .germi-rules file (added to your existing scenarios)"
        onClick={onImport}
      >
        Import
      </button>
      <button
        className="btn small"
        title="Replace all scenarios with the contents of a .germi-rules file"
        onClick={onReplace}
      >
        Replace…
      </button>
      <button
        className="btn small"
        title="Export all scenarios to a shareable .germi-rules file"
        disabled={ar.scenarios.length === 0}
        onClick={onExportAll}
      >
        Export all
      </button>
    </div>
  );
}

export function AutoresponderPanel({
  ar,
  scenarioActions,
  ruleActions,
  transferActions,
  selectRuleId,
  ruleHits,
  bulkMockProgress,
  reloadToken,
  layout,
  openWindowRuleIds,
  onOpenRuleWindow,
}: AutoresponderPanelProps) {
  const [pendingDelete, setPendingDelete] = useState<ScenarioSummary | null>(null);
  const [pendingReplace, setPendingReplace] = useState(false);
  const [collapsed, setCollapsed] = useDetailCollapsed();
  const { zone, zoneProps } = useFlowDrop(transferActions.dropMock);

  // Which scenario's rules are shown/edited. Distinct from the *active* scenario
  // because the General layer is editable without ever being active. Follows the
  // active scenario when it changes (create / activate / external edits); the
  // General tab sets it directly without touching the active pointer.
  const [viewedId, setViewedId] = useState<string | null>(ar.activeScenarioId);
  useEffect(() => {
    setViewedId(ar.activeScenarioId);
  }, [ar.activeScenarioId]);

  const activateAndView = (id: string | null) => {
    scenarioActions.activate(id);
    setViewedId(id);
  };

  const viewed = ar.scenarios.find((s) => s.id === viewedId) ?? null;
  const isGeneral = viewed?.id === GENERAL_SCENARIO_ID;

  return (
    <div className="autoresponder">
      <ScenarioTabs
        ar={ar}
        zone={zone}
        zoneProps={zoneProps}
        viewedId={viewedId}
        onSelectView={setViewedId}
        onActivate={activateAndView}
        onToggleGeneral={scenarioActions.setGeneralActive}
        onAdd={() => void scenarioActions.create()}
        onImport={() => transferActions.importRules(false)}
        onReplace={() => setPendingReplace(true)}
        onExportAll={() => transferActions.exportRules(null)}
      />

      <BulkMockProgress event={bulkMockProgress} />

      {viewed ? (
        <ScenarioView
          key={viewed.id}
          active={viewed}
          isGeneral={isGeneral}
          generalActive={ar.generalActive}
          onToggleGeneral={() => scenarioActions.setGeneralActive(!ar.generalActive)}
          onRequestDelete={() => setPendingDelete(viewed)}
          selectRuleId={selectRuleId}
          reloadToken={reloadToken}
          ruleHits={ruleHits}
          drop={{ active: zone === "__body__", props: zoneProps("__body__", viewed.id) }}
          scenarioActions={scenarioActions}
          ruleActions={ruleActions}
          onExport={() => transferActions.exportRules(viewed.id)}
          layout={layout}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          openWindowRuleIds={openWindowRuleIds}
          onOpenRuleWindow={onOpenRuleWindow}
        />
      ) : (
        <AutoresponderOffState
          empty={ar.scenarios.filter((s) => s.id !== GENERAL_SCENARIO_ID).length === 0}
          dropActive={zone === "__off__"}
          dropProps={zoneProps("__off__", null)}
          onCreate={() => void scenarioActions.create()}
        />
      )}

      <AutoresponderDialogs
        ar={ar}
        pendingDelete={pendingDelete}
        pendingReplace={pendingReplace}
        onCancelDelete={() => setPendingDelete(null)}
        onConfirmDelete={() => {
          if (pendingDelete) scenarioActions.delete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancelReplace={() => setPendingReplace(false)}
        onConfirmReplace={() => {
          setPendingReplace(false);
          transferActions.importRules(true);
        }}
      />
    </div>
  );
}

function BulkMockProgress({ event }: { event: BulkMockEvent | null }) {
  if (event?.type !== "progress" || event.total === 0) return null;
  const label =
    event.phase === "saving"
      ? "Saving mock rules…"
      : `Creating mock rules… ${event.completed}/${event.total}`;
  return (
    <div className="bulk-mock-progress" role="status" aria-live="polite">
      <span>{label}</span>
      <progress value={event.completed} max={event.total} />
    </div>
  );
}

function AutoresponderOffState({
  empty,
  dropActive,
  dropProps,
  onCreate,
}: {
  empty: boolean;
  dropActive: boolean;
  dropProps: FlowDropZone;
  onCreate: () => void;
}) {
  return (
    <div className={`off-state ${dropActive ? "drop-target" : ""}`} {...dropProps}>
      <h3>Autoresponder is off</h3>
      <p className="muted">
        Capturing traffic only — nothing is mocked. Pick a scenario tab above to make its rules
        live, create a new one, or drag requests here to mock them.
      </p>
      {empty && (
        <button className="btn primary" onClick={onCreate}>
          + Create a scenario
        </button>
      )}
    </div>
  );
}

function AutoresponderDialogs({
  ar,
  pendingDelete,
  pendingReplace,
  onCancelDelete,
  onConfirmDelete,
  onCancelReplace,
  onConfirmReplace,
}: {
  ar: AutoResponderSummary;
  pendingDelete: ScenarioSummary | null;
  pendingReplace: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onCancelReplace: () => void;
  onConfirmReplace: () => void;
}) {
  return (
    <>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete scenario?"
          message={`Delete “${pendingDelete.name}” and its ${pendingDelete.rules.length} rule(s)? This can't be undone.`}
          confirmLabel="Delete scenario"
          danger
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      )}
      {pendingReplace && (
        <ConfirmDialog
          title="Replace all scenarios?"
          message={
            ar.scenarios.length > 0
              ? `This replaces all ${ar.scenarios.length} of your scenario(s) with the ones in the file you pick. Mocking switches off until you activate a scenario. This can't be undone.`
              : `This loads the scenarios from the file you pick. Mocking stays off until you activate one.`
          }
          confirmLabel="Choose file & replace"
          danger
          onConfirm={onConfirmReplace}
          onCancel={onCancelReplace}
        />
      )}
    </>
  );
}

function NumberDraftInput({
  value,
  min,
  max,
  onCommit,
  width = 78,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  width?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const n = Math.trunc(Number(draft));
    if (draft.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) {
      onCommit(n);
      setDraft(String(n));
    } else {
      setDraft(String(value));
    }
  }
  return (
    <input
      type="number"
      min={min}
      max={Number.isFinite(max) ? max : undefined}
      style={{ width }}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function FireLimitFields({
  rule,
  hits,
  onPatch,
}: {
  rule: Rule;
  hits: number;
  onPatch: (patch: Partial<Rule>) => void;
}) {
  return (
    <>
      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={rule.fireLimit !== null}
            onChange={(e) => onPatch({ fireLimit: e.target.checked ? 1 : null })}
          />
          Match once (auto-disable after first hit)
        </label>
      </div>
      {rule.fireLimit !== null && (
        <div className="row">
          <label>Fire N times</label>
          <NumberDraftInput
            value={rule.fireLimit}
            min={1}
            max={4294967295}
            onCommit={(n) => onPatch({ fireLimit: n })}
          />
          <span className="muted small">
            {hits}/{rule.fireLimit} fired
          </span>
          <label className="check">
            <input
              type="checkbox"
              checked={rule.repeat}
              onChange={(e) => onPatch({ repeat: e.target.checked })}
            />
            Repeat (loop instead of stopping)
          </label>
        </div>
      )}
    </>
  );
}

export function RuleEditor({
  rule,
  hits,
  onPatch,
  onDelete,
}: {
  rule: Rule;
  hits: number;
  onPatch: (patch: Partial<Rule>, tag?: HistoryTag) => void;
  onDelete: () => void;
}) {
  function setAction(patch: Partial<Action>, tag?: HistoryTag) {
    onPatch({ action: { ...rule.action, ...patch } as Action }, tag);
  }

  const warnings = ruleWarnings(rule);

  return (
    <div className="editor-form">
      <div className="row end">
        <button className="btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="rule-warnings">
          {warnings.map((w) => (
            <div key={w} className="warn-text small">
              <IconWarn /> {w}
            </div>
          ))}
        </div>
      )}

      <Section title="Match">
        <div className="row">
          <label>Method</label>
          <select
            value={rule.matcher.method ?? ""}
            onChange={(e) =>
              onPatch({
                matcher: { ...rule.matcher, method: e.target.value || null },
              })
            }
          >
            <option value="">any</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={rule.matcher.urlMatch}
            onChange={(e) =>
              onPatch({
                matcher: {
                  ...rule.matcher,
                  urlMatch: e.target.value as Rule["matcher"]["urlMatch"],
                },
              })
            }
          >
            <option value="contains">contains</option>
            <option value="exact">exact</option>
            <option value="regex">regex</option>
          </select>
        </div>
        <div className="row">
          <label>URL</label>
          <input
            className="grow"
            placeholder="e.g. /api/health   or   example.com/users"
            value={rule.matcher.url}
            onChange={(e) => onPatch({ matcher: { ...rule.matcher, url: e.target.value } })}
          />
        </div>
      </Section>

      <Section title="Behavior — fire limit" defaultOpen={rule.fireLimit !== null}>
        <FireLimitFields rule={rule} hits={hits} onPatch={onPatch} />
      </Section>

      <Section title="Action">
        <div className="row">
          <label>Type</label>
          <select
            value={rule.action.kind}
            onChange={(e) => onPatch({ action: defaultAction(e.target.value as ActionKind) })}
          >
            {ACTION_KINDS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <ActionFields action={rule.action} setAction={setAction} />
      </Section>
    </div>
  );
}

const STATUS_REASON: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
const STATUS_PRESETS = [200, 201, 204, 400, 401, 403, 404, 500, 503];

function formatJson(body: string): string | null {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return null;
  }
}

/**
 * Whether a Content-Type is text-editable inline. Mirrors the inspector's
 * `is_textual` (crates/proxy-core/src/flow.rs) + `classify` (FlowInspector):
 * text/*, JSON, JS, XML/HTML/SVG, CSS, form-urlencoded, CSV, GraphQL are
 * editable; images (except SVG), fonts, audio/video, wasm, octet-stream, PDF,
 * zip etc. are binary — a CodeMirror text editor would show U+FFFD garbage for
 * them, and edits can't produce a valid binary asset anyway. For those the
 * editor is replaced with a hint to use Map Local.
 */
function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (!ct) return true; // empty default → editable (the starter rule is JSON)
  if (ct.startsWith("text/")) return true;
  if (ct.includes("svg")) return true; // image/svg+xml is text
  if (/(json|javascript|ecmascript|xml|html|x-www-form-urlencoded|csv|graphql)/.test(ct)) {
    return true;
  }
  return false;
}

function StatusField({ status, onChange }: { status: number; onChange: (s: number) => void }) {
  return (
    <div className="status-field">
      <div className="row status-row">
        <label>Status</label>
        <NumberDraftInput value={status} min={100} max={599} onCommit={onChange} />
        <span className="muted reason">{STATUS_REASON[status] ?? ""}</span>
      </div>
      <div className="status-presets">
        {STATUS_PRESETS.map((s) => (
          <button
            key={s}
            className={`chip ${s === status ? "on" : ""}`}
            onClick={() => onChange(s)}
            title={`${s} ${STATUS_REASON[s] ?? ""}`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

const ENCODING_OPTIONS = ["", "gzip", "br", "deflate"] as const;

/**
 * Pick the Content-Encoding the rule applies to the served body on the wire.
 * `""` (None) sends the body as identity bytes — today's default. Any other
 * value re-compresses the (always-decoded, editable) body at serve time and
 * stamps the `Content-Encoding` header. The editor always shows decoded text.
 */
function ContentEncodingField({
  encoding,
  onChange,
}: {
  encoding: string | null;
  onChange: (e: string | null) => void;
}) {
  const value = encoding ?? "";
  return (
    <div className="row">
      <label>Content-Encoding</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        title="Compress the served body on the wire. The editor always shows decoded text; the engine re-encodes when the rule fires."
      >
        {ENCODING_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {opt === "" ? "none (identity)" : opt}
          </option>
        ))}
      </select>
      {value && (
        <Tooltip label={`Response will be ${value}-encoded on the wire`}>
          <span className="muted small">
            <IconMock />
          </span>
        </Tooltip>
      )}
    </div>
  );
}

function HeadersTable({
  headers,
  onChange,
}: {
  headers: [string, string][];
  onChange: (h: [string, string][]) => void;
}) {
  // Keep stable per-row ids so removing a middle row doesn't rebind input DOM
  // state (focus / selection / IME) to the wrong logical row (the index-as-key
  // anti-pattern). The DTO stays [name, value][]; ids are local-only.
  const nextId = useRef(0);
  const seed = () => headers.map(([name, value]) => ({ id: nextId.current++, name, value }));
  const [rows, setRows] = useState(seed);

  // RuleEditor is keyed by rule id, so it does NOT remount when the rule is
  // replaced externally (undo, a cross-window reload) — only its `headers` prop
  // changes. Re-seed the rows on such a change so the table can't show and
  // re-commit stale headers. Our own edits echo back with equal content, so this
  // compares content (not reference) to avoid stomping in-progress typing.
  const committed = useRef(headers);
  if (!isEqual(committed.current, headers)) {
    committed.current = headers;
    setRows(seed());
  }

  const emit = (next: { id: number; name: string; value: string }[]) => {
    setRows(next);
    const pairs = next.map((r) => [r.name, r.value] as [string, string]);
    committed.current = pairs;
    onChange(pairs);
  };

  return (
    <div className="headers-table">
      <div className="row">
        <label>Headers</label>
        <button
          className="btn small"
          onClick={() => emit([...rows, { id: nextId.current++, name: "", value: "" }])}
        >
          + Add header
        </button>
      </div>
      {rows.map((row) => (
        <div className="header-row" key={row.id}>
          <input
            placeholder="Name"
            value={row.name}
            onChange={(e) =>
              emit(rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))
            }
          />
          <input
            placeholder="Value"
            value={row.value}
            onChange={(e) =>
              emit(rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
            }
          />
          <button
            className="btn ghost"
            title="Remove header"
            onClick={() => emit(rows.filter((r) => r.id !== row.id))}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}

function MapLocalFields({
  path,
  status,
  setAction,
}: {
  path: string;
  status: number;
  setAction: (patch: Partial<Action>) => void;
}) {
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (!path) {
      setExists(null);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      void api.fileExists(path).then((e) => {
        if (active) setExists(e);
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [path]);

  async function browse() {
    const p = await api.pickFile();
    if (p) setAction({ path: p });
  }

  return (
    <>
      <div className="row">
        <label>File path</label>
        <input
          className="grow"
          placeholder="/absolute/path/to/response.json"
          value={path}
          onChange={(e) => setAction({ path: e.target.value })}
        />
        <button className="btn" onClick={browse}>
          Browse…
        </button>
      </div>
      {path && exists === false && (
        <div className="warn-text small">
          <IconWarn /> File not found — this rule will be skipped at request time.
        </div>
      )}
      <StatusField status={status} onChange={(s) => setAction({ status: s })} />
    </>
  );
}

function RespondFields({
  action,
  setAction,
}: {
  action: Extract<Action, { kind: "respond" }>;
  setAction: (patch: Partial<Action>, tag?: HistoryTag) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [wrap, setWrap] = useState(false);
  const contentType = action.contentType ?? "";
  const textual = isTextualContentType(contentType);

  const editor = (fill: boolean) => (
    <Suspense fallback={<div className="muted pad small">Loading editor…</div>}>
      <BodyEditor
        value={action.body}
        contentType={contentType}
        onChange={(b) => setAction({ body: b })}
        fill={fill}
        wrap={wrap}
      />
    </Suspense>
  );

  return (
    <>
      <StatusField status={action.status} onChange={(s) => setAction({ status: s })} />
      <div className="row">
        <label>Content-Type</label>
        <input
          className="grow"
          value={contentType}
          onChange={(e) => setAction({ contentType: e.target.value })}
        />
      </div>
      <ContentEncodingField
        encoding={action.contentEncoding}
        onChange={(e) => setAction({ contentEncoding: e })}
      />
      <HeadersTable headers={action.headers} onChange={(h) => setAction({ headers: h })} />
      {textual ? (
        <>
          <div className="row body-head">
            <label>Body</label>
            <button
              className="btn small"
              title="Pretty-print JSON"
              onClick={() => {
                const f = formatJson(action.body);
                if (f !== null) setAction({ body: f }, { label: "Format body", coalesceKey: null });
              }}
            >
              Format
            </button>
            <button
              className={wrap ? "btn small active" : "btn small"}
              title="Toggle word wrap"
              onClick={() => setWrap((w) => !w)}
            >
              Wrap
            </button>
            <button
              className="btn small"
              title="Maximize editor (full view)"
              onClick={() => setMaximized(true)}
            >
              <IconMaximize /> Maximize
            </button>
          </div>
          {maximized ? (
            <MaximizedOverlay title="Response body" onClose={() => setMaximized(false)}>
              {editor(true)}
            </MaximizedOverlay>
          ) : (
            editor(false)
          )}
        </>
      ) : (
        <div className="muted pad small">
          Binary content type — inline editing isn’t supported for {contentType.split(";")[0]}. Use{" "}
          <strong>Map Local</strong> to serve the file directly, or set a text Content-Type (e.g.{" "}
          <code>application/json</code>) to edit the body inline.
        </div>
      )}
    </>
  );
}

function ActionFields({
  action,
  setAction,
}: {
  action: Action;
  setAction: (patch: Partial<Action>, tag?: HistoryTag) => void;
}) {
  switch (action.kind) {
    case "respond":
      return <RespondFields action={action} setAction={setAction} />;
    case "mapLocal":
      return <MapLocalFields path={action.path} status={action.status} setAction={setAction} />;
    case "setRequestHeader":
    case "setResponseHeader":
      return (
        <div className="row">
          <label>Header</label>
          <input
            placeholder="X-Header-Name"
            value={action.name}
            onChange={(e) => setAction({ name: e.target.value })}
          />
          <input
            className="grow"
            placeholder="value"
            value={action.value}
            onChange={(e) => setAction({ value: e.target.value })}
          />
        </div>
      );
    case "setStatus":
      return <StatusField status={action.status} onChange={(s) => setAction({ status: s })} />;
    case "rewriteResponseBody":
      return (
        <>
          <div className="row">
            <label>Find</label>
            <input
              className="grow"
              value={action.find}
              onChange={(e) => setAction({ find: e.target.value })}
            />
          </div>
          <div className="row">
            <label>Replace</label>
            <input
              className="grow"
              value={action.replace}
              onChange={(e) => setAction({ replace: e.target.value })}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={action.regex}
                onChange={(e) => setAction({ regex: e.target.checked })}
              />
              regex
            </label>
          </div>
        </>
      );
    case "block":
      return <div className="muted pad">Matching requests get a 403.</div>;
    case "cors":
      return (
        <div className="muted pad">
          Makes matching traffic CORS-friendly for browser apps: answers preflights (OPTIONS) with a
          204 echoing the requested method and headers, and stamps Access-Control headers — the
          request's Origin, credentials, exposed headers — on matching responses, mocked or passed
          through. Place it above your mocks so preflights don't consume their fire limits.
        </div>
      );
  }
}
