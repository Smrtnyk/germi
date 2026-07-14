import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { api } from "../ipc";
import { LatestSaveQueue } from "../latestSaveQueue";
import { blankScript, errorsById, scriptFromExample, type ScriptExample } from "../scriptsState";
import {
  currentScriptsWindowLabel,
  emitScriptsChanged,
  isScriptsWindowOpen,
  onScriptsChanged,
  onScriptsWindowClosed,
} from "../scriptWindows";
import type { Script } from "../types";
import { Button } from "./ui/Button";
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
      api.checkScript(script.source).then(
        (error) => ({ id: script.id, name: script.name, error }),
        (error: unknown) => ({ id: script.id, name: script.name, error: String(error) }),
      ),
    ),
  );
  return { scripts, errors: errorsById(diagnostics) };
}

/** Persist the script list — immediately, or debounced while typing — flag compile
 *  errors, tell the other window to reload, and flush a pending save on unmount. */
function useScriptPersistence(
  setErrors: (errors: Map<string, string>) => void,
  setSaveError: (error: string | null) => void,
  label: string,
) {
  const saveRef = useRef<(next: Script[]) => Promise<void>>(async () => {});
  saveRef.current = async (next) => {
    try {
      const diagnostics = await api.setScripts(next);
      setErrors(errorsById(diagnostics));
      setSaveError(null);
      emitScriptsChanged(label);
    } catch (error) {
      setSaveError(String(error));
      throw error;
    }
  };
  const queueRef = useRef<LatestSaveQueue<Script[]> | null>(null);
  queueRef.current ??= new LatestSaveQueue((next) => saveRef.current(next), SAVE_DEBOUNCE_MS);
  const queue = queueRef.current;

  const persist = useCallback((next: Script[]) => queue.saveNow(next), [queue]);
  const persistDebounced = useCallback((next: Script[]) => queue.schedule(next), [queue]);
  const flush = useCallback(() => queue.flush(), [queue]);
  const cancelPending = useCallback(() => queue.cancelPending(), [queue]);

  useEffect(
    () => () => {
      void flush().catch(() => {});
    },
    [flush],
  );

  return { persist, persistDebounced, flush, cancelPending };
}

function useScriptsWindowGate(enabled: boolean, onClosed: () => Promise<void>) {
  // The docked editor starts locked until the shell confirms that no detached
  // writer exists. Otherwise an app/webview reload briefly exposes a second
  // editable copy while the asynchronous window lookup is still in flight.
  const [windowOpen, setWindowOpen] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setWindowOpen(false);
      return;
    }
    let alive = true;
    let closeGeneration = 0;
    let unlisten: (() => void) | undefined;
    void onScriptsWindowClosed(() => {
      const generation = ++closeGeneration;
      // The shell emits this only after the detached webview is actually gone.
      // Reload here as well as on `scripts-changed`: the detached window's final
      // save can complete immediately before destruction, and its fire-and-forget
      // webview event is not a reliable ownership hand-off on its own.
      void onClosed()
        .then(() => {
          if (alive && generation === closeGeneration) setWindowOpen(false);
        })
        .catch(() => {
          // A failed durable reload leaves ownership conservatively locked. An
          // empty/stale docked editor must never overwrite the detached save.
        });
    })
      .then((fn) => {
        if (!alive) {
          fn();
          return;
        }
        unlisten = fn;
        const generation = closeGeneration;
        void isScriptsWindowOpen()
          .then(async (open) => {
            if (!alive || generation !== closeGeneration) return;
            if (open) {
              setWindowOpen(true);
              return;
            }
            // Also covers a close that happened just before the destroyed-event
            // listener was installed. Reload from disk before exposing controls.
            await onClosed();
            if (alive && generation === closeGeneration) setWindowOpen(false);
          })
          .catch(() => {
            // Ownership is unknown. Keep the docked editor read-only: unlocking
            // here can create two writers while a detached editor is still open.
            // Its Focus action can retry opening/focusing the detached window.
          });
      })
      .catch(() => {
        // Without the destroyed listener we cannot safely prove ownership has
        // returned to this webview, so retain the initial read-only gate.
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [enabled, onClosed]);

  return { windowOpen, setWindowOpen };
}

/** Reload when the OTHER window saves (own broadcasts are skipped via `source`). */
function useExternalScriptsReload(label: string, reload: () => Promise<void>) {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onScriptsChanged((payload) => {
      if (payload.source !== label) void reload().catch(() => {});
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [label, reload]);
}

function useScriptListActions(
  scripts: Script[],
  setScripts: (next: Script[]) => void,
  setSelectedId: (update: (current: string | null) => string | null) => void,
  persist: (next: Script[]) => Promise<void>,
  persistDebounced: (next: Script[]) => void,
) {
  const addScript = useCallback(
    (script: Script) => {
      const next = [...scripts, script];
      setScripts(next);
      setSelectedId(() => script.id);
      void persist(next).catch(() => {});
    },
    [scripts, setScripts, setSelectedId, persist],
  );

  const patchScript = useCallback(
    (id: string, patch: Partial<Script>) => {
      const next = scripts.map((script) => (script.id === id ? { ...script, ...patch } : script));
      setScripts(next);
      persistDebounced(next);
    },
    [scripts, setScripts, persistDebounced],
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
      void persist(next).catch(() => {});
    },
    [scripts, setScripts, persist],
  );

  const onDelete = useCallback(
    (id: string) => {
      const next = scripts.filter((script) => script.id !== id);
      setScripts(next);
      setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
      void persist(next).catch(() => {});
    },
    [scripts, setScripts, setSelectedId, persist],
  );

  return { onAdd, onInsertExample, onRename, onSourceChange, onToggle, onDelete };
}

function useScriptsEditorState() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  return {
    scripts,
    setScripts,
    selectedId,
    setSelectedId,
    errors,
    setErrors,
    saveError,
    setSaveError,
    loaded,
    setLoaded,
  };
}

/** Owns the script list + persistence, wiring the presentational
 *  {@link ScriptsPanel} to the Tauri commands. Kept mounted in the docked tab (its
 *  pane is only hidden) so edits survive tab switches; also reused by the detached
 *  {@link ScriptsWindow}. */
export function ScriptsContainer({
  onPopOut,
  flushRef,
}: {
  onPopOut?: () => Promise<unknown>;
  flushRef?: RefObject<() => Promise<void>>;
} = {}) {
  const {
    scripts,
    setScripts,
    selectedId,
    setSelectedId,
    errors,
    setErrors,
    saveError,
    setSaveError,
    loaded,
    setLoaded,
  } = useScriptsEditorState();
  const reloadGeneration = useRef(0);
  const label = currentScriptsWindowLabel();

  const { persist, persistDebounced, flush, cancelPending } = useScriptPersistence(
    setErrors,
    setSaveError,
    label,
  );

  const reload = useCallback((): Promise<void> => {
    const generation = ++reloadGeneration.current;
    cancelPending();
    setLoaded(false);
    // cancelPending cannot abort a write that already reached the backend. Wait
    // for that write before reading the durable snapshot, otherwise this reload
    // can install stale scripts after the write succeeds. A failed active write
    // is intentionally replaced by whatever the backend can actually load.
    return flush()
      .catch(() => {})
      .then(loadScriptsWithDiagnostics)
      .then((snapshot) => {
        // Close notifications and cross-window save broadcasts can overlap.
        // Only the newest durable read may replace the editor snapshot.
        if (generation !== reloadGeneration.current) return;
        setScripts(snapshot.scripts);
        setErrors(snapshot.errors);
        setSaveError(null);
        setLoaded(true);
        setSelectedId((current) =>
          current !== null && snapshot.scripts.some((script) => script.id === current)
            ? current
            : (snapshot.scripts[0]?.id ?? null),
        );
      })
      .catch((error: unknown) => {
        if (generation === reloadGeneration.current) {
          setSaveError(`Scripts could not be loaded safely: ${String(error)}`);
        }
        throw error;
      });
  }, [cancelPending, flush, setErrors, setLoaded, setSaveError, setScripts, setSelectedId]);

  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);
  useExternalScriptsReload(label, reload);

  const { windowOpen, setWindowOpen } = useScriptsWindowGate(onPopOut !== undefined, reload);
  if (flushRef) flushRef.current = flush;

  const popOut = useCallback(() => {
    void (async () => {
      try {
        await flush();
      } catch {
        return;
      }
      setWindowOpen(true);
      try {
        await onPopOut?.();
        setSaveError(null);
      } catch (error) {
        setSaveError(String(error));
        // Focusing an existing window can fail without destroying that window.
        // Re-check ownership before unlocking the docked editor; if the lookup
        // itself fails, retain the conservative read-only state.
        try {
          setWindowOpen(await isScriptsWindowOpen());
        } catch {
          setWindowOpen(true);
        }
      }
    })();
  }, [flush, onPopOut, setSaveError, setWindowOpen]);

  const actions = useScriptListActions(
    scripts,
    setScripts,
    setSelectedId,
    persist,
    persistDebounced,
  );

  if (!loaded) {
    return (
      <div className="muted pad">
        <div>{saveError ?? "Loading scripts…"}</div>
        {saveError && <Button onClick={() => void reload().catch(() => {})}>Retry</Button>}
      </div>
    );
  }

  return (
    <ScriptsPanel
      model={{ scripts, selectedId, errors, saveError, poppedOut: windowOpen }}
      actions={{
        onSelect: setSelectedId,
        ...actions,
        onPopOut: onPopOut ? popOut : undefined,
        onFocusWindow: onPopOut ? popOut : undefined,
      }}
    />
  );
}
