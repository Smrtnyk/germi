import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { api } from "../ipc";
import type { Action, ActionKind, AutoResponder, Rule, Scenario } from "../types";
import { useResizable } from "../useResizable";
import { ConfirmDialog } from "./ConfirmDialog";
import { RuleTester } from "./RuleTester";

// Lazy-loaded so CodeMirror (and its language packs) is a separate chunk fetched
// only when a mock body is actually edited — keeps app startup light.
const BodyEditor = lazy(() => import("./BodyEditor").then((m) => ({ default: m.BodyEditor })));

interface Props {
  ar: AutoResponder;
  onChange: (ar: AutoResponder) => void;
  /** When set (e.g. via "Mock this"), select this rule for editing. */
  selectRuleId?: string | null;
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
    matcher: { method: null, url: "", urlMatch: "contains" },
    action: defaultAction("respond"),
  };
}

function RuleListItem({
  rule,
  selected,
  onSelect,
  onToggle,
  onDuplicate,
}: {
  rule: Rule;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onDuplicate: () => void;
}) {
  return (
    <div className={`rule-item ${selected ? "selected" : ""}`} onClick={onSelect} title={rule.name}>
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
        <div className="rsub">{ruleSummary(rule)}</div>
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

function ScenarioView({
  active,
  onPatch,
  onRequestDelete,
  selectRuleId,
}: {
  active: Scenario;
  onPatch: (patch: Partial<Scenario>) => void;
  onRequestDelete: () => void;
  selectRuleId?: string | null;
}) {
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const rulesRef = useRef<HTMLDivElement>(null);
  const listResize = useResizable({
    initial: 240,
    min: 170,
    getMax: () => (rulesRef.current?.clientWidth ?? 700) - 280,
    storageKey: "germi.ruleListWidth",
  });

  useEffect(() => {
    if (selectRuleId) setSelectedRuleId(selectRuleId);
  }, [selectRuleId]);

  function setRules(rules: Rule[]) {
    onPatch({ rules });
  }
  function addRule() {
    const r = newRule();
    setRules([...active.rules, r]);
    setSelectedRuleId(r.id);
  }
  function patchRule(id: string, patch: Partial<Rule>) {
    setRules(active.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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

  const selectedRule = active.rules.find((r) => r.id === selectedRuleId) ?? null;

  return (
    <div className="scenario-body">
      <div className="scenario-head">
        <input
          className="scenario-name"
          value={active.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <span className="muted small">
          {active.rules.filter((r) => r.enabled).length}/{active.rules.length} rule(s) active · live
        </span>
        <div className="spacer" />
        <button className="btn danger" onClick={onRequestDelete}>
          Delete scenario
        </button>
      </div>

      <div
        className="rules"
        ref={rulesRef}
        style={{
          gridTemplateColumns: `minmax(0, ${listResize.size}px) 6px minmax(280px, 1fr)`,
        }}
      >
        <aside className="rule-list">
          <button className="btn primary block" onClick={addRule}>
            + Add rule
          </button>
          {active.rules.length === 0 && (
            <div className="muted pad">No rules in this scenario yet.</div>
          )}
          {active.rules.map((r) => (
            <RuleListItem
              key={r.id}
              rule={r}
              selected={r.id === selectedRuleId}
              onSelect={() => setSelectedRuleId(r.id)}
              onToggle={(enabled) => patchRule(r.id, { enabled })}
              onDuplicate={() => duplicateRule(r.id)}
            />
          ))}
        </aside>

        <div className="resizer" onPointerDown={listResize.onPointerDown} title="Drag to resize" />

        <section className="rule-editor">
          {!selectedRule ? (
            <div className="muted pad">Select a rule to edit it, or add one.</div>
          ) : (
            <RuleEditor
              key={selectedRule.id}
              rule={selectedRule}
              onPatch={(patch) => patchRule(selectedRule.id, patch)}
              onDelete={() => deleteRule(selectedRule.id)}
            />
          )}

          <RuleTester
            rules={{ rules: active.rules }}
            seedMethod={selectedRule?.matcher.method ?? undefined}
            seedUrl={selectedRule?.matcher.url || undefined}
          />
        </section>
      </div>
    </div>
  );
}

export function AutoresponderPanel({ ar, onChange, selectRuleId }: Props) {
  const [pendingDelete, setPendingDelete] = useState<Scenario | null>(null);

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
      <div className="scenario-tabs">
        {ar.scenarios.map((s) => (
          <button
            key={s.id}
            className={`stab ${s.id === ar.activeScenarioId ? "active" : ""}`}
            onClick={() => activate(s.id)}
          >
            {s.name}
            {s.id === ar.activeScenarioId && <span className="live-dot" />}
          </button>
        ))}
        <button className="stab add" onClick={addScenario} title="New scenario">
          +
        </button>
        <div className="spacer" />
        <button
          className={`stab off ${ar.activeScenarioId === null ? "active" : ""}`}
          onClick={() => activate(null)}
          title="Disable mocking — capture only"
        >
          ⏻ Off
        </button>
      </div>

      {!active ? (
        <div className="off-state">
          <h3>Autoresponder is off</h3>
          <p className="muted">
            Capturing traffic only — nothing is mocked. Pick a scenario tab above to make its rules
            live, or create a new one.
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
    </div>
  );
}

function RuleEditor({
  rule,
  onPatch,
  onDelete,
}: {
  rule: Rule;
  onPatch: (patch: Partial<Rule>) => void;
  onDelete: () => void;
}) {
  function setAction(patch: Partial<Action>) {
    onPatch({ action: { ...rule.action, ...patch } as Action });
  }

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

      <h4>Match</h4>
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

      <h4>Action</h4>
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
  // Local draft so the field can be cleared / retyped without immediately
  // committing an invalid status 0 (Number("") === 0). Commit a valid HTTP
  // status (100–599) on blur/Enter, otherwise revert to the last good value.
  const [draft, setDraft] = useState(String(status));
  useEffect(() => setDraft(String(status)), [status]);
  const commit = () => {
    const n = Math.trunc(Number(draft));
    if (draft.trim() !== "" && Number.isFinite(n) && n >= 100 && n <= 599) {
      onChange(n);
      setDraft(String(n));
    } else {
      setDraft(String(status));
    }
  };
  return (
    <div className="status-field">
      <div className="row status-row">
        <label>Status</label>
        <input
          type="number"
          style={{ width: 78 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
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
