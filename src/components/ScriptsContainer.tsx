import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../ipc";
import { blankScript, errorsById, scriptFromExample, type ScriptExample } from "../scriptsState";
import { currentWindowLabel, emitScriptsChanged, onScriptsChanged } from "../scriptWindows";
import type { Script } from "../types";
import { ScriptsPanel } from "./ScriptsPanel";

const SAVE_DEBOUNCE_MS = 400;

/** Load the stored scripts and re-check each source, so a script that no longer
 *  compiles is flagged on load (setScripts only reports errors at save time). */
async function loadScriptsWithDiagnostics(): Promise<{
  scripts: Script[];
  errors: Map<string, string>;
}> {
  const scripts = await api.getScripts();
  const diagnostics = await Promise.all(
    scripts.map((script) =>
      api.checkScript(script.source).then((error) => ({ id: script.id, name: script.name, error })),
    ),
  );
  return { scripts, errors: errorsById(diagnostics) };
}

/** Persist the script list — immediately, or debounced while typing — flag compile
 *  errors, tell the other window to reload, and flush a pending save on unmount. */
function useScriptPersistence(setErrors: (errors: Map<string, string>) => void, label: string) {
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<Script[] | null>(null);

  const persist = useCallback(
    (next: Script[]) => {
      pending.current = null;
      api
        .setScripts(next)
        .then((diagnostics) => {
          setErrors(errorsById(diagnostics));
          emitScriptsChanged(label);
        })
        .catch(() => {});
    },
    [setErrors, label],
  );

  const persistDebounced = useCallback(
    (next: Script[]) => {
      pending.current = next;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => persist(next), SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (pending.current) persist(pending.current);
    },
    [persist],
  );

  return { persist, persistDebounced };
}

/** Reload when the OTHER window saves (own broadcasts are skipped via `source`). */
function useExternalScriptsReload(label: string, reload: () => void) {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onScriptsChanged((payload) => {
      if (payload.source !== label) reload();
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [label, reload]);
}

/** Owns the script list + persistence, wiring the presentational
 *  {@link ScriptsPanel} to the Tauri commands. Kept mounted in the docked tab (its
 *  pane is only hidden) so edits survive tab switches; also reused by the detached
 *  {@link ScriptsWindow}. */
export function ScriptsContainer({ onPopOut }: { onPopOut?: () => void } = {}) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const label = currentWindowLabel();

  const reload = useCallback(() => {
    void loadScriptsWithDiagnostics()
      .then((loaded) => {
        setScripts(loaded.scripts);
        setErrors(loaded.errors);
        setSelectedId((current) => current ?? loaded.scripts[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);
  useExternalScriptsReload(label, reload);

  const { persist, persistDebounced } = useScriptPersistence(setErrors, label);

  const addScript = useCallback(
    (script: Script) => {
      const next = [...scripts, script];
      setScripts(next);
      setSelectedId(script.id);
      persist(next);
    },
    [scripts, persist],
  );

  const patchScript = useCallback(
    (id: string, patch: Partial<Script>) => {
      const next = scripts.map((script) => (script.id === id ? { ...script, ...patch } : script));
      setScripts(next);
      persistDebounced(next);
    },
    [scripts, persistDebounced],
  );

  const onAdd = useCallback(() => addScript(blankScript(scripts)), [addScript, scripts]);
  const onInsertExample = useCallback(
    (example: ScriptExample) => addScript(scriptFromExample(example, scripts)),
    [addScript, scripts],
  );
  const onRename = useCallback(
    (id: string, name: string) => patchScript(id, { name }),
    [patchScript],
  );
  const onSourceChange = useCallback(
    (id: string, source: string) => patchScript(id, { source }),
    [patchScript],
  );

  const onToggle = useCallback(
    (id: string) => {
      const next = scripts.map((script) =>
        script.id === id ? { ...script, enabled: !script.enabled } : script,
      );
      setScripts(next);
      persist(next);
    },
    [scripts, persist],
  );

  const onDelete = useCallback(
    (id: string) => {
      const next = scripts.filter((script) => script.id !== id);
      setScripts(next);
      setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
      persist(next);
    },
    [scripts, persist],
  );

  return (
    <ScriptsPanel
      scripts={scripts}
      selectedId={selectedId}
      errors={errors}
      onSelect={setSelectedId}
      onAdd={onAdd}
      onInsertExample={onInsertExample}
      onDelete={onDelete}
      onToggle={onToggle}
      onRename={onRename}
      onSourceChange={onSourceChange}
      onPopOut={onPopOut}
    />
  );
}
