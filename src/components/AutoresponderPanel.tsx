import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";

import { api } from "../ipc";
import { decodeFlowIds, FLOW_DRAG_MIME, hasFlowDrag } from "../dnd";
import type { Action, ActionKind, AutoResponder, Rule, Scenario } from "../types";
import { useResizable } from "../useResizable";
import { ConfirmDialog } from "./ConfirmDialog";
import { RuleTester } from "./RuleTester";

// Lazy-loaded so CodeMirror (and its language packs) is a separate chunk fetched
// only when a mock body is actually edited — keeps app startup light.
const BodyEditor = lazy(() => import("./BodyEditor").then((m) => ({ default: m.BodyEditor })));

export interface AutoresponderPanelProps {
  ar: AutoResponder;
  onChange: (ar: AutoResponder) => void;
  /** When set (e.g. via "Mock this"), select this rule for editing. */
  selectRuleId?: string | null;
  onResetState: (scenarioId: string | null) => void;
  ruleHits: Record<string, number>;
  onExportRules: (scenarioId: string | null) => void;
  onImportRules: (replace: boolean) => void;
  onDropMock: (ids: string[], scenarioId: string | null) => void;
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

function actionSummary(a: Action): string {
  switch (a.kind) {
    case "respond":
      return `${a.status}${a.contentType ? " " + a.contentType.split(";")[0] : ""}`;
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

function ruleSummary(r: Rule): string {
  return `${r.matcher.method || "ANY"} · ${r.matcher.url || "*"} → ${actionSummary(r.action)}`;
}

function newRule(): Rule {
  return {
    id: crypto.randomUUID(),
    name: "New rule",
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: null, url: "", urlMatch: "contains" },
    action: defaultAction("respond"),
  };
}

function fireBadge(rule: Rule): string | null {
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
  onDuplicate,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  rule: Rule;
  selected: boolean;
  hits: number;
  draggable: boolean;
  dragOver: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onDuplicate: () => void;
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
      title={rule.name}
      draggable={draggable}
      onDragStart={(e) => {
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
      <button
        className="btn ghost dup"
        title="Duplicate rule"
        onClick={(e) => {
          e.stopPropagation();
          onDuplicate();
        }}
      >
        ⧉
      </button>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved";

interface ScenarioRules {
  saveState: SaveState;
  patch: (p: Partial<Scenario>) => void;
  addRule: () => void;
  patchRule: (id: string, p: Partial<Rule>) => void;
  deleteRule: (id: string) => void;
  duplicateRule: (id: string) => void;
  reorder: (dragId: string | null, toId: string) => void;
}

function useScenarioRules(
  active: Scenario,
  onPatch: (patch: Partial<Scenario>) => void,
  selectedRuleId: string | null,
  setSelectedRuleId: (id: string | null) => void,
): ScenarioRules {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function patch(p: Partial<Scenario>) {
    onPatch(p);
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaveState("saved"), 650);
  }
  function setRules(rules: Rule[]) {
    patch({ rules });
  }
  function addRule() {
    const r = newRule();
    setRules([...active.rules, r]);
    setSelectedRuleId(r.id);
  }
  function patchRule(id: string, p: Partial<Rule>) {
    setRules(active.rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }
  function deleteRule(id: string) {
    setRules(active.rules.filter((r) => r.id !== id));
    if (selectedRuleId === id) setSelectedRuleId(null);
  }
  function duplicateRule(id: string) {
    const idx = active.rules.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const orig = active.rules[idx];
    const copy: Rule = {
      ...orig,
      id: crypto.randomUUID(),
      name: `${orig.name} copy`,
      matcher: { ...orig.matcher },
      action: structuredClone(orig.action),
    };
    setRules([...active.rules.slice(0, idx + 1), copy, ...active.rules.slice(idx + 1)]);
    setSelectedRuleId(copy.id);
  }
  function reorder(dragId: string | null, toId: string) {
    if (!dragId || dragId === toId) return;
    const arr = [...active.rules];
    const from = arr.findIndex((r) => r.id === dragId);
    const to = arr.findIndex((r) => r.id === toId);
    if (from === -1 || to === -1) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setRules(arr);
  }

  return { saveState, patch, addRule, patchRule, deleteRule, duplicateRule, reorder };
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

function RuleList({
  rules,
  shownRules,
  query,
  setQuery,
  selectedRuleId,
  setSelectedRuleId,
  canReorder,
  dragId,
  setDragId,
  overId,
  setOverId,
  ruleHits,
  onAdd,
  onToggle,
  onDuplicate,
  onReorder,
}: {
  rules: Rule[];
  shownRules: Rule[];
  query: string;
  setQuery: (q: string) => void;
  selectedRuleId: string | null;
  setSelectedRuleId: (id: string | null) => void;
  canReorder: boolean;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  overId: string | null;
  setOverId: (id: string | null) => void;
  ruleHits: Record<string, number>;
  onAdd: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDuplicate: (id: string) => void;
  onReorder: (toId: string) => void;
}) {
  return (
    <aside className="rule-list">
      <button className="btn primary block" onClick={onAdd}>
        + Add rule
      </button>
      {rules.length > 4 && (
        <input
          className="rule-search"
          placeholder="Search rules…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {rules.length === 0 && <div className="muted pad">No rules in this scenario yet.</div>}
      {rules.length > 0 && shownRules.length === 0 && (
        <div className="muted pad small">No rules match “{query}”.</div>
      )}
      {shownRules.map((r) => (
        <RuleListItem
          key={r.id}
          rule={r}
          selected={r.id === selectedRuleId}
          hits={ruleHits[r.id] ?? 0}
          draggable={canReorder}
          dragOver={overId === r.id && dragId !== r.id}
          onSelect={() => setSelectedRuleId(r.id)}
          onToggle={(enabled) => onToggle(r.id, enabled)}
          onDuplicate={() => onDuplicate(r.id)}
          onDragStart={() => setDragId(r.id)}
          onDragOver={() => setOverId(r.id)}
          onDrop={() => {
            onReorder(r.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
        />
      ))}
    </aside>
  );
}

function RuleEditorPane({
  rules,
  selectedRule,
  ruleHits,
  onPatchRule,
  onDeleteRule,
}: {
  rules: Rule[];
  selectedRule: Rule | null;
  ruleHits: Record<string, number>;
  onPatchRule: (id: string, p: Partial<Rule>) => void;
  onDeleteRule: (id: string) => void;
}) {
  return (
    <section className="rule-editor">
      {!selectedRule ? (
        <div className="muted pad">Select a rule to edit it, or add one.</div>
      ) : (
        <RuleEditor
          key={selectedRule.id}
          rule={selectedRule}
          hits={ruleHits[selectedRule.id] ?? 0}
          onPatch={(p) => onPatchRule(selectedRule.id, p)}
          onDelete={() => onDeleteRule(selectedRule.id)}
        />
      )}

      <RuleTester
        rules={{ rules }}
        seedMethod={selectedRule?.matcher.method ?? undefined}
        seedUrl={selectedRule?.matcher.url || undefined}
      />
    </section>
  );
}

function ScenarioView({
  active,
  onPatch,
  onRequestDelete,
  selectRuleId,
  onResetState,
  ruleHits,
  onExport,
  dropActive,
  dropProps,
}: {
  active: Scenario;
  onPatch: (patch: Partial<Scenario>) => void;
  onRequestDelete: () => void;
  selectRuleId?: string | null;
  onResetState: () => void;
  ruleHits: Record<string, number>;
  onExport: () => void;
  dropActive: boolean;
  dropProps: FlowDropZone;
}) {
  const sel = useRuleSelection(selectRuleId);
  const {
    selectedRuleId,
    setSelectedRuleId,
    query,
    setQuery,
    dragId,
    setDragId,
    overId,
    setOverId,
  } = sel;
  const rules = useScenarioRules(active, onPatch, selectedRuleId, setSelectedRuleId);
  const rulesRef = useRef<HTMLDivElement>(null);
  const listResize = useResizable({
    initial: 240,
    min: 170,
    getMax: () => (rulesRef.current?.clientWidth ?? 700) - 280,
    storageKey: "germi.ruleListWidth",
  });

  const q = query.trim().toLowerCase();
  const shownRules = q
    ? active.rules.filter(
        (r) => r.name.toLowerCase().includes(q) || r.matcher.url.toLowerCase().includes(q),
      )
    : active.rules;
  const selectedRule = active.rules.find((r) => r.id === selectedRuleId) ?? null;

  return (
    <div className={`scenario-body ${dropActive ? "drop-target" : ""}`} {...dropProps}>
      <div className="scenario-head">
        <input
          className="scenario-name"
          value={active.name}
          onChange={(e) => rules.patch({ name: e.target.value })}
        />
        <span className="muted small scenario-status">
          {active.rules.filter((r) => r.enabled).length}/{active.rules.length} active
          {rules.saveState === "saving" && <span className="save-state"> · saving…</span>}
          {rules.saveState === "saved" && <span className="save-state ok"> · saved ✓</span>}
        </span>
        <div className="scenario-actions">
          <button
            className="btn"
            title="Clear per-rule hit counters so match-once / sequenced rules fire from the start again."
            onClick={onResetState}
          >
            Reset state
          </button>
          <button
            className="btn"
            title="Export this scenario to a shareable .germi-rules file"
            onClick={onExport}
          >
            Export scenario
          </button>
          <button className="btn danger" onClick={onRequestDelete}>
            Delete scenario
          </button>
        </div>
      </div>

      <div
        className="rules"
        ref={rulesRef}
        style={{
          gridTemplateColumns: `minmax(0, ${listResize.size}px) 6px minmax(280px, 1fr)`,
        }}
      >
        <RuleList
          rules={active.rules}
          shownRules={shownRules}
          query={query}
          setQuery={setQuery}
          selectedRuleId={selectedRuleId}
          setSelectedRuleId={setSelectedRuleId}
          canReorder={!q}
          dragId={dragId}
          setDragId={setDragId}
          overId={overId}
          setOverId={setOverId}
          ruleHits={ruleHits}
          onAdd={rules.addRule}
          onToggle={(id, enabled) => rules.patchRule(id, { enabled })}
          onDuplicate={rules.duplicateRule}
          onReorder={(toId) => rules.reorder(dragId, toId)}
        />

        <div className="resizer" onPointerDown={listResize.onPointerDown} title="Drag to resize" />

        <RuleEditorPane
          rules={active.rules}
          selectedRule={selectedRule}
          ruleHits={ruleHits}
          onPatchRule={rules.patchRule}
          onDeleteRule={rules.deleteRule}
        />
      </div>
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
  ar: AutoResponder;
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
  onChange,
  selectRuleId,
  onResetState,
  ruleHits,
  onExportRules,
  onImportRules,
  onDropMock,
}: AutoresponderPanelProps) {
  const [pendingDelete, setPendingDelete] = useState<Scenario | null>(null);
  const [pendingReplace, setPendingReplace] = useState(false);
  const { zone, zoneProps } = useFlowDrop(onDropMock);

  const active = ar.scenarios.find((s) => s.id === ar.activeScenarioId) ?? null;

  function activate(id: string | null) {
    onChange({ ...ar, activeScenarioId: id });
  }
  function addScenario() {
    const s: Scenario = {
      id: crypto.randomUUID(),
      name: `Scenario ${ar.scenarios.length + 1}`,
      rules: [],
    };
    onChange({ scenarios: [...ar.scenarios, s], activeScenarioId: s.id });
  }
  function patchScenario(id: string, patch: Partial<Scenario>) {
    onChange({
      ...ar,
      scenarios: ar.scenarios.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }
  function deleteScenario(id: string) {
    onChange({
      scenarios: ar.scenarios.filter((s) => s.id !== id),
      activeScenarioId: ar.activeScenarioId === id ? null : ar.activeScenarioId,
    });
  }

  return (
    <div className="autoresponder">
      <ScenarioTabs
        ar={ar}
        zone={zone}
        zoneProps={zoneProps}
        onActivate={activate}
        onAdd={addScenario}
        onImport={() => onImportRules(false)}
        onReplace={() => setPendingReplace(true)}
        onExportAll={() => onExportRules(null)}
      />

      {!active ? (
        <div
          className={`off-state ${zone === "__off__" ? "drop-target" : ""}`}
          {...zoneProps("__off__", null)}
        >
          <h3>Autoresponder is off</h3>
          <p className="muted">
            Capturing traffic only — nothing is mocked. Pick a scenario tab above to make its rules
            live, create a new one, or drag requests here to mock them.
          </p>
          {ar.scenarios.length === 0 && (
            <button className="btn primary" onClick={addScenario}>
              + Create a scenario
            </button>
          )}
        </div>
      ) : (
        <ScenarioView
          key={active.id}
          active={active}
          onPatch={(patch) => patchScenario(active.id, patch)}
          onRequestDelete={() => setPendingDelete(active)}
          selectRuleId={selectRuleId}
          onResetState={() => onResetState(active.id)}
          ruleHits={ruleHits}
          onExport={() => onExportRules(active.id)}
          dropActive={zone === "__body__"}
          dropProps={zoneProps("__body__", active.id)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete scenario?"
          message={`Delete “${pendingDelete.name}” and its ${pendingDelete.rules.length} rule(s)? This can't be undone.`}
          confirmLabel="Delete scenario"
          danger
          onConfirm={() => {
            deleteScenario(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
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
          onConfirm={() => {
            setPendingReplace(false);
            onImportRules(true);
          }}
          onCancel={() => setPendingReplace(false)}
        />
      )}
    </div>
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
  onPatch: (patch: Partial<Rule>) => void;
  onDelete: () => void;
}) {
  function setAction(patch: Partial<Action>) {
    onPatch({ action: { ...rule.action, ...patch } as Action });
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

function ActionFields({
  action,
  setAction,
}: {
  action: Action;
  setAction: (patch: Partial<Action>) => void;
}) {
  switch (action.kind) {
    case "respond": {
      const contentType = action.contentType ?? "";
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
          <HeadersTable headers={action.headers} onChange={(h) => setAction({ headers: h })} />
          <div className="row body-head">
            <label>Body</label>
            <button
              className="btn small"
              title="Pretty-print JSON"
              onClick={() => {
                const f = formatJson(action.body);
                if (f !== null) setAction({ body: f });
              }}
            >
              Format
            </button>
          </div>
          <Suspense fallback={<div className="muted pad small">Loading editor…</div>}>
            <BodyEditor
              value={action.body}
              contentType={contentType}
              onChange={(b) => setAction({ body: b })}
            />
          </Suspense>
        </>
      );
    }
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
