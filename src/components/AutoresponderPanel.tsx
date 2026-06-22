import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { api } from "../ipc";
import { decodeFlowIds, FLOW_DRAG_MIME, hasFlowDrag, RULE_DRAG_MIME } from "../dnd";
import type {
  Action,
  ActionKind,
  ActionSummary,
  AutoResponderSummary,
  BulkMockEvent,
  HistoryTag,
  Rule,
  RuleSummary,
  ScenarioSummary,
} from "../types";
import { useResizable } from "../useResizable";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { MaximizedOverlay } from "./MaximizedOverlay";
import { RuleTester } from "./RuleTester";
import { Tooltip } from "./Tooltip";

// Lazy-loaded so CodeMirror (and its language packs) is a separate chunk fetched
// only when a mock body is actually edited — keeps app startup light.
const BodyEditor = lazy(() => import("./BodyEditor").then((m) => ({ default: m.BodyEditor })));

interface ScenarioActions {
  activate: (scenarioId: string | null) => void;
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
}

const ACTION_KINDS: { value: ActionKind; label: string }[] = [
  { value: "respond", label: "Auto-respond (mock)" },
  { value: "mapLocal", label: "Map local file" },
  { value: "setResponseHeader", label: "Set response header" },
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
  }
}

/** Keep the unique tail of long URL-ish names visible (CSS can't middle-ellipsis). */
function middleTruncate(s: string, max = 46): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.62);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function actionSummary(a: ActionSummary): string {
  switch (a.kind) {
    case "respond":
      return `${a.status}${a.contentType ? " " + a.contentType.split(";")[0] : ""}${a.contentEncoding ? ` · ${a.contentEncoding}` : ""}`;
    case "mapLocal":
      return `file → ${a.status}`;
    case "block":
      return "block 403";
    case "setStatus":
      return `status ${a.status}`;
    case "setResponseHeader":
      return `resp ${a.name || "header"}`;
    case "setRequestHeader":
      return `req ${a.name || "header"}`;
    case "rewriteResponseBody":
      return "rewrite body";
  }
}

function ruleSummary(r: RuleSummary): string {
  return `${r.matcher.method || "ANY"} · ${r.matcher.url || "*"} → ${actionSummary(r.action)}`;
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
    try {
      RegExp(rule.matcher.url);
    } catch {
      w.push("URL regex is invalid — this rule will never match.");
    }
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
        <span className="rsection-caret">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="rsection-body">{children}</div>}
    </div>
  );
}

function RuleListItem({
  rule,
  selected,
  hits,
  draggable,
  dragOver,
  onSelect,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  rule: RuleSummary;
  selected: boolean;
  hits: number;
  draggable: boolean;
  dragOver: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const badge = fireBadge(rule);
  return (
    <div
      className={`rule-item ${selected ? "selected" : ""} ${dragOver ? "dragover" : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={rule.name}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(RULE_DRAG_MIME, rule.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        if (!draggable || hasFlowDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e) => {
        if (hasFlowDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      {draggable && (
        <span className="rgrip" title="Drag to reorder (evaluation order matters)">
          ⠿
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
          <span className={`rname ${rule.enabled ? "" : "off"}`}>{middleTruncate(rule.name)}</span>
          {rule.action.kind !== "respond" && <span className="rkind">{rule.action.kind}</span>}
        </div>
        <div className="rsub">
          {ruleSummary(rule)}
          {badge && (
            <span className="rfire">
              {badge}
              {rule.fireLimit !== null && ` ${hits}/${rule.fireLimit}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved";

function useSelectedRule(
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

  useEffect(() => {
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
      if (pending) await updateRuleRef.current(scenarioId, pending);
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

function useRuleSelection(selectRuleId?: string | null) {
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    if (selectRuleId) setSelectedRuleId(selectRuleId);
  }, [selectRuleId]);

  return {
    selectedRuleId,
    setSelectedRuleId,
    query,
    setQuery,
    dragId,
    setDragId,
    overId,
    setOverId,
  };
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
}

function ruleMenuItems(
  rule: RuleSummary,
  canReorder: boolean,
  actions: RuleMenuActions,
): MenuItem[] {
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
): {
  openMenu: (event: ReactMouseEvent, rule: RuleSummary) => void;
  menuElement: ReactElement | null;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; rule: RuleSummary } | null>(null);
  function openMenu(event: ReactMouseEvent, rule: RuleSummary) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, rule });
  }
  const menuElement = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={ruleMenuItems(menu.rule, canReorder, actions)}
      onClose={() => setMenu(null)}
    />
  ) : null;
  return { openMenu, menuElement };
}

interface RuleListBehavior {
  selectedRuleId: string | null;
  setSelectedRuleId: (id: string | null) => void;
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

function RuleListToolbar({
  ruleCount,
  query,
  setQuery,
  onAdd,
}: {
  ruleCount: number;
  query: string;
  setQuery: (q: string) => void;
  onAdd: () => void;
}) {
  return (
    <>
      <button className="btn primary block" onClick={onAdd}>
        + Add rule
      </button>
      {ruleCount > 4 && (
        <input
          className="rule-search"
          placeholder="Search rules…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
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
  onAdd,
  behavior,
}: {
  rules: RuleSummary[];
  shownRules: RuleSummary[];
  query: string;
  setQuery: (q: string) => void;
  onAdd: () => void;
  behavior: RuleListBehavior;
}) {
  return (
    <aside className="rule-list">
      <RuleListToolbar ruleCount={rules.length} query={query} setQuery={setQuery} onAdd={onAdd} />
      <RuleListMessage ruleCount={rules.length} shownCount={shownRules.length} query={query} />
      <VirtualRuleList rules={shownRules} behavior={behavior} />
    </aside>
  );
}

function VirtualRuleList({
  rules,
  behavior,
}: {
  rules: RuleSummary[];
  behavior: RuleListBehavior;
}) {
  const {
    selectedRuleId,
    setSelectedRuleId,
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
  const { openMenu, menuElement } = useRuleMenu(canReorder, {
    onMoveToTop,
    onMoveToBottom,
    onDuplicate,
    onToggle,
    onDelete,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedIndex = rules.findIndex((rule) => rule.id === selectedRuleId);
  const virtualizer = useVirtualizer({
    count: rules.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rules[index].id,
    estimateSize: () => 52,
    overscan: 8,
  });

  useEffect(() => {
    if (selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, virtualizer]);

  return (
    <div ref={scrollRef} className="rule-list-viewport">
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
                selected={rule.id === selectedRuleId}
                hits={ruleHits[rule.id] ?? 0}
                draggable={canReorder}
                dragOver={overId === rule.id && dragId !== rule.id}
                onSelect={() => setSelectedRuleId(rule.id)}
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

function RuleEditorPane({
  scenarioId,
  selectedRule,
  loading,
  ruleHits,
  onPatchRule,
  onDeleteRule,
}: {
  scenarioId: string;
  selectedRule: Rule | null;
  loading: boolean;
  ruleHits: Record<string, number>;
  onPatchRule: (p: Partial<Rule>, tag?: HistoryTag) => void;
  onDeleteRule: (id: string) => void;
}) {
  return (
    <section className="rule-editor">
      {!selectedRule ? (
        <div className="muted pad">
          {loading ? "Loading rule…" : "Select a rule to edit it, or add one."}
        </div>
      ) : (
        <RuleEditor
          key={selectedRule.id}
          rule={selectedRule}
          hits={ruleHits[selectedRule.id] ?? 0}
          onPatch={onPatchRule}
          onDelete={() => onDeleteRule(selectedRule.id)}
        />
      )}

      <RuleTester
        scenarioId={scenarioId}
        seedMethod={selectedRule?.matcher.method ?? undefined}
        seedUrl={selectedRule?.matcher.url || undefined}
      />
    </section>
  );
}

function useScenarioName(
  scenario: ScenarioSummary,
  onRenameScenario: (scenarioId: string, name: string) => void,
) {
  const [name, setName] = useState(scenario.name);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timer = useRef<number | null>(null);
  const pendingName = useRef<string | null>(null);
  const renameRef = useRef(onRenameScenario);
  renameRef.current = onRenameScenario;

  useEffect(() => {
    setName(scenario.name);
    setSaveState("idle");
  }, [scenario.id, scenario.name]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const pending = pendingName.current;
      if (pending !== null) renameRef.current(scenario.id, pending);
    },
    [scenario.id],
  );

  function change(next: string) {
    setName(next);
    pendingName.current = next;
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      pendingName.current = null;
      renameRef.current(scenario.id, next);
      setSaveState("saved");
    }, 300);
  }

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const pending = pendingName.current;
    pendingName.current = null;
    if (pending !== null) renameRef.current(scenario.id, pending);
  }

  return { name, change, saveState, flush };
}

function useScenarioWorkspace(
  active: ScenarioSummary,
  selectRuleId: string | null | undefined,
  ruleActions: RuleActions,
  reloadToken?: number,
) {
  const selection = useRuleSelection(selectRuleId);
  const editor = useSelectedRule(
    active.id,
    selection.selectedRuleId,
    ruleActions.load,
    ruleActions.update,
    reloadToken,
  );
  const rulesRef = useRef<HTMLDivElement>(null);
  const listResize = useResizable({
    initial: 240,
    min: 170,
    getMax: () => (rulesRef.current?.clientWidth ?? 700) - 280,
    storageKey: "germi.ruleListWidth",
  });

  const q = selection.query.trim().toLowerCase();
  const shownRules = useMemo(
    () =>
      q
        ? active.rules.filter(
            (r) => r.name.toLowerCase().includes(q) || r.matcher.url.toLowerCase().includes(q),
          )
        : active.rules,
    [active.rules, q],
  );

  async function addRule() {
    const created = await ruleActions.create(active.id);
    if (created) selection.setSelectedRuleId(created.id);
  }

  async function toggleRule(id: string, enabled: boolean) {
    if (editor.rule?.id === id) {
      editor.patch({ enabled });
      return;
    }
    const rule = await ruleActions.load(id);
    if (rule) await ruleActions.update(active.id, { ...rule, enabled });
  }

  async function duplicateRule(id: string) {
    if (editor.rule?.id === id) await editor.flush();
    const created = await ruleActions.duplicate(active.id, id);
    if (created) selection.setSelectedRuleId(created.id);
  }

  function deleteRule(id: string) {
    if (selection.selectedRuleId === id) {
      editor.clearPending();
      selection.setSelectedRuleId(null);
    }
    ruleActions.delete(active.id, id);
  }

  return {
    selection,
    editor,
    rulesRef,
    listResize,
    shownRules,
    addRule,
    toggleRule,
    duplicateRule,
    deleteRule,
  };
}

type ScenarioWorkspace = ReturnType<typeof useScenarioWorkspace>;
type ScenarioNameEditor = ReturnType<typeof useScenarioName>;

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
      <span className="muted small scenario-status">
        {active.rules.filter((rule) => rule.enabled).length}/{active.rules.length} active
        {(nameEditor.saveState === "saving" || ruleSaveState === "saving") && (
          <span className="save-state"> · saving…</span>
        )}
        {(nameEditor.saveState === "saved" || ruleSaveState === "saved") && (
          <span className="save-state ok"> · saved ✓</span>
        )}
      </span>
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

function ScenarioRuleWorkspace({
  active,
  workspace,
  ruleHits,
  ruleActions,
}: {
  active: ScenarioSummary;
  workspace: ScenarioWorkspace;
  ruleHits: Record<string, number>;
  ruleActions: RuleActions;
}) {
  const { selection, editor, listResize } = workspace;
  const behavior: RuleListBehavior = {
    selectedRuleId: selection.selectedRuleId,
    setSelectedRuleId: selection.setSelectedRuleId,
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

  return (
    <div
      className="rules"
      ref={workspace.rulesRef}
      style={{
        gridTemplateColumns: `minmax(0, ${listResize.size}px) 6px minmax(280px, 1fr)`,
      }}
    >
      <RuleList
        rules={active.rules}
        shownRules={workspace.shownRules}
        query={selection.query}
        setQuery={selection.setQuery}
        onAdd={() => void workspace.addRule()}
        behavior={behavior}
      />

      <div className="resizer" onPointerDown={listResize.onPointerDown} title="Drag to resize" />

      <RuleEditorPane
        scenarioId={active.id}
        selectedRule={editor.rule}
        loading={editor.loading}
        ruleHits={ruleHits}
        onPatchRule={editor.patch}
        onDeleteRule={workspace.deleteRule}
      />
    </div>
  );
}

function ScenarioView({
  active,
  onRequestDelete,
  selectRuleId,
  reloadToken,
  ruleHits,
  drop,
  scenarioActions,
  ruleActions,
  onExport,
}: {
  active: ScenarioSummary;
  onRequestDelete: () => void;
  selectRuleId?: string | null;
  reloadToken?: number;
  ruleHits: Record<string, number>;
  drop: { active: boolean; props: FlowDropZone };
  scenarioActions: ScenarioActions;
  ruleActions: RuleActions;
  onExport: () => void;
}) {
  const workspace = useScenarioWorkspace(active, selectRuleId, ruleActions, reloadToken);
  const nameEditor = useScenarioName(active, scenarioActions.rename);
  const exportScenario = () => {
    nameEditor.flush();
    void workspace.editor.flush().then(onExport);
  };

  return (
    <div className={`scenario-body ${drop.active ? "drop-target" : ""}`} {...drop.props}>
      <ScenarioHeader
        active={active}
        nameEditor={nameEditor}
        ruleSaveState={workspace.editor.saveState}
        actions={{
          reset: () => scenarioActions.resetState(active.id),
          export: exportScenario,
          requestDelete: onRequestDelete,
        }}
      />
      <ScenarioRuleWorkspace
        active={active}
        workspace={workspace}
        ruleHits={ruleHits}
        ruleActions={ruleActions}
      />
    </div>
  );
}

function ScenarioTabs({
  ar,
  zone,
  zoneProps,
  onActivate,
  onAdd,
  onImport,
  onReplace,
  onExportAll,
}: {
  ar: AutoResponderSummary;
  zone: string | null;
  zoneProps: FlowDrop["zoneProps"];
  onActivate: (id: string | null) => void;
  onAdd: () => void;
  onImport: () => void;
  onReplace: () => void;
  onExportAll: () => void;
}) {
  return (
    <div className="scenario-tabs">
      {ar.scenarios.map((s) => (
        <button
          key={s.id}
          className={`stab ${s.id === ar.activeScenarioId ? "active" : ""} ${
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
        ⏻ Off
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
}: AutoresponderPanelProps) {
  const [pendingDelete, setPendingDelete] = useState<ScenarioSummary | null>(null);
  const [pendingReplace, setPendingReplace] = useState(false);
  const { zone, zoneProps } = useFlowDrop(transferActions.dropMock);

  const active = ar.scenarios.find((s) => s.id === ar.activeScenarioId) ?? null;

  return (
    <div className="autoresponder">
      <ScenarioTabs
        ar={ar}
        zone={zone}
        zoneProps={zoneProps}
        onActivate={scenarioActions.activate}
        onAdd={() => void scenarioActions.create()}
        onImport={() => transferActions.importRules(false)}
        onReplace={() => setPendingReplace(true)}
        onExportAll={() => transferActions.exportRules(null)}
      />

      <BulkMockProgress event={bulkMockProgress} />

      {active ? (
        <ScenarioView
          key={active.id}
          active={active}
          onRequestDelete={() => setPendingDelete(active)}
          selectRuleId={selectRuleId}
          reloadToken={reloadToken}
          ruleHits={ruleHits}
          drop={{ active: zone === "__body__", props: zoneProps("__body__", active.id) }}
          scenarioActions={scenarioActions}
          ruleActions={ruleActions}
          onExport={() => transferActions.exportRules(active.id)}
        />
      ) : (
        <AutoresponderOffState
          empty={ar.scenarios.length === 0}
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

function RuleEditor({
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
      <div className="row">
        <label>Name</label>
        <input
          className="grow"
          value={rule.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <button className="btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="rule-warnings">
          {warnings.map((w) => (
            <div key={w} className="warn-text small">
              ⚠ {w}
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
          <span className="muted small">⚡</span>
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
  // anti-pattern). The DTO stays [name, value][]; ids are local-only. This
  // component remounts per rule (RuleEditor is keyed by rule id) and per action
  // kind, so the prop is the source of truth only at mount.
  const nextId = useRef(0);
  const [rows, setRows] = useState(() =>
    headers.map(([name, value]) => ({ id: nextId.current++, name, value })),
  );

  const emit = (next: { id: number; name: string; value: string }[]) => {
    setRows(next);
    onChange(next.map((r) => [r.name, r.value] as [string, string]));
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
            ✕
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
          ⚠ File not found — this rule will be skipped at request time.
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
  const contentType = action.contentType ?? "";
  const textual = isTextualContentType(contentType);

  const editor = (fill: boolean) => (
    <Suspense fallback={<div className="muted pad small">Loading editor…</div>}>
      <BodyEditor
        value={action.body}
        contentType={contentType}
        onChange={(b) => setAction({ body: b })}
        fill={fill}
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
              className="btn small"
              title="Maximize editor (full view)"
              onClick={() => setMaximized(true)}
            >
              ⤢ Maximize
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
  }
}
