import { lazy, Suspense, useState } from "react";

import { SCRIPT_EXAMPLES, type ScriptExample } from "../scriptsState";
import type { Script } from "../types";
import { IconClose, IconScript, IconWarn } from "./icons";
import { Button } from "./ui/Button";

// Keep CodeMirror out of the startup bundle (same boundary as the mock editor).
const BodyEditor = lazy(() => import("./BodyEditor").then((m) => ({ default: m.BodyEditor })));

export interface ScriptsPanelProps {
  scripts: Script[];
  selectedId: string | null;
  /** Script id -> compile error message, for scripts that don't compile. */
  errors: Map<string, string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onInsertExample: (example: ScriptExample) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSourceChange: (id: string, source: string) => void;
  /** Optional "open in a window" action (present in the docked panel only). */
  onPopOut?: () => void;
}

/** Presentational (IPC-free) editor for user request/response scripts: a list of
 *  scripts with enable toggles, a code editor for the selected one, and a built-in
 *  guide (how it works + API reference + insertable examples). */
export function ScriptsPanel({
  scripts,
  selectedId,
  errors,
  onSelect,
  onAdd,
  onInsertExample,
  onDelete,
  onToggle,
  onRename,
  onSourceChange,
  onPopOut,
}: ScriptsPanelProps) {
  const [showGuide, setShowGuide] = useState(false);
  const selected = scripts.find((script) => script.id === selectedId) ?? null;
  // The guide doubles as the empty state, so it also shows when nothing's picked.
  const guideVisible = showGuide || !selected;

  return (
    <div className="scripts-panel">
      <ScriptsToolbar
        showGuide={showGuide}
        onToggleGuide={() => setShowGuide((v) => !v)}
        onNew={() => {
          onAdd();
          setShowGuide(false);
        }}
        onPopOut={onPopOut}
      />

      <div className="scripts-list">
        {scripts.length === 0 && (
          <p className="muted pad small">No scripts yet — see the guide below.</p>
        )}
        {scripts.map((script) => (
          <ScriptRow
            key={script.id}
            script={script}
            selected={script.id === selectedId}
            error={errors.get(script.id)}
            onSelect={() => {
              onSelect(script.id);
              setShowGuide(false);
            }}
            onToggle={() => onToggle(script.id)}
            onDelete={() => onDelete(script.id)}
          />
        ))}
      </div>

      {guideVisible ? (
        <ScriptsGuide
          onInsert={(example) => {
            onInsertExample(example);
            setShowGuide(false);
          }}
        />
      ) : (
        selected && (
          <ScriptEditorPane
            script={selected}
            error={errors.get(selected.id)}
            onRename={onRename}
            onSourceChange={onSourceChange}
          />
        )
      )}
    </div>
  );
}

function ScriptsToolbar({
  showGuide,
  onToggleGuide,
  onNew,
  onPopOut,
}: {
  showGuide: boolean;
  onToggleGuide: () => void;
  onNew: () => void;
  onPopOut?: () => void;
}) {
  return (
    <div className="scripts-toolbar">
      <span className="scripts-title">
        <IconScript /> Scripts
      </span>
      <div className="spacer" />
      <Button
        variant={showGuide ? "default" : "ghost"}
        size="small"
        active={showGuide}
        title="How scripts work, the API, and examples"
        onClick={onToggleGuide}
      >
        Guide
      </Button>
      {onPopOut && (
        <Button variant="ghost" size="small" title="Edit in a separate window" onClick={onPopOut}>
          Open window
        </Button>
      )}
      <Button size="small" onClick={onNew}>
        New
      </Button>
    </div>
  );
}

function ScriptRow({
  script,
  selected,
  error,
  onSelect,
  onToggle,
  onDelete,
}: {
  script: Script;
  selected: boolean;
  error?: string;
  onSelect: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={selected ? "script-row active" : "script-row"} onClick={onSelect}>
      <input
        type="checkbox"
        checked={script.enabled}
        title={script.enabled ? "Enabled" : "Disabled"}
        aria-label={`Enable ${script.name}`}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
      />
      <span className="script-row-name">{script.name}</span>
      {error !== undefined && (
        <span className="script-row-error" title={error}>
          <IconWarn />
        </span>
      )}
      <Button
        variant="ghost"
        size="small"
        title={`Delete ${script.name}`}
        aria-label={`Delete ${script.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <IconClose />
      </Button>
    </div>
  );
}

function ScriptEditorPane({
  script,
  error,
  onRename,
  onSourceChange,
}: {
  script: Script;
  error?: string;
  onRename: (id: string, name: string) => void;
  onSourceChange: (id: string, source: string) => void;
}) {
  return (
    <div className="script-editor">
      <input
        className="script-name-input"
        value={script.name}
        aria-label="Script name"
        onChange={(e) => onRename(script.id, e.target.value)}
      />
      {error && <div className="script-error">{error}</div>}
      <div className="script-editor-cm">
        <Suspense fallback={<div className="muted pad small">Loading editor…</div>}>
          <BodyEditor
            value={script.source}
            onChange={(value) => onSourceChange(script.id, value)}
            contentType="application/javascript"
            fill
            wrap
          />
        </Suspense>
      </div>
    </div>
  );
}

/** How-it-works + API reference + one-click examples. */
function ScriptsGuide({ onInsert }: { onInsert: (example: ScriptExample) => void }) {
  return (
    <div className="scripts-guide">
      <p className="small">
        Scripts run on <strong>every request and response</strong>, including mocked ones. Define{" "}
        <code>on_request(req)</code> and/or <code>on_response(req, res)</code> in{" "}
        <a href="https://rhai.rs/book/" target="_blank" rel="noreferrer">
          Rhai
        </a>
        ; changes apply live to new traffic.
      </p>

      <h4 className="scripts-guide-h">Read (on req or res)</h4>
      <ul className="scripts-api">
        <li>
          <code>.method</code> <code>.url</code> <code>.host</code> <code>.path</code>{" "}
          <code>.query</code> <code>.status</code> <code>.body</code>
        </li>
        <li>
          <code>.header(name)</code> — value or <code>""</code>; <code>.has_header(name)</code>
        </li>
      </ul>

      <h4 className="scripts-guide-h">Write (on req or res)</h4>
      <ul className="scripts-api">
        <li>
          <code>.set_header(name, value)</code> — replace
        </li>
        <li>
          <code>.add_header(name, value)</code> — add without replacing
        </li>
        <li>
          <code>.remove_header(name)</code> — delete
        </li>
        <li>
          <code>res.set_status(code)</code> — change the response status
        </li>
      </ul>

      <h4 className="scripts-guide-h">Examples</h4>
      <div className="scripts-examples">
        {SCRIPT_EXAMPLES.map((example) => (
          <div key={example.id} className="script-example">
            <div className="script-example-info">
              <span className="script-example-name">{example.name}</span>
              <span className="script-example-desc muted small">{example.description}</span>
            </div>
            <Button
              size="small"
              aria-label={`Insert ${example.name}`}
              onClick={() => onInsert(example)}
            >
              Insert
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
