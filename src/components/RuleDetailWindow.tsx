import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "../ipc";
import { ruleLabel } from "../autoresponderState";
import type { HistoryTag, Rule } from "../types";
import {
  currentRuleWindowLabel,
  emitRuleWindowResized,
  emitRulesChanged,
  onRuleWindowsFlushRequested,
  onRulesChanged,
} from "../ruleWindows";
import { RuleEditor, useSelectedRule } from "./AutoresponderPanel";
import { RuleTester } from "./RuleTester";

type Editor = ReturnType<typeof useSelectedRule>;

/** Broadcast this window's (logical) size on resize, debounced, so the main
 *  window can persist it and open subsequent windows at the same size. */
function useRememberWindowSize(): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    void win
      .onResized(({ payload }) => {
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => {
          void win.scaleFactor().then((scale) => {
            emitRuleWindowResized({ width: payload.width / scale, height: payload.height / scale });
          });
        }, 400);
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}

/** Re-fetch only when THIS rule changes elsewhere — a main-window undo/redo
 *  broadcasts ruleId=null (reload-all); another window's save to a different rule
 *  is ignored so it can't clobber this window's in-progress typing. Own broadcasts
 *  are skipped via `source`. */
function useExternalReloadToken(
  label: string,
  ruleId: string,
  onError: (error: unknown) => void,
): { reloadToken: number; ready: boolean } {
  const [reloadToken, setReloadToken] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    setReady(false);
    void onRulesChanged((p) => {
      if (p.source === label) return;
      if (p.ruleId === null || p.ruleId === ruleId) setReloadToken((t) => t + 1);
    })
      .then((fn) => {
        if (active) {
          unlisten = fn;
          setReady(true);
        } else fn();
      })
      .catch(onError);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [label, onError, ruleId]);
  return { reloadToken, ready };
}

/** Live fire-count for this rule so the detached editor's "n/N fired" badge is
 *  accurate (the main list polls the same source). Re-polls on a modest interval
 *  and whenever the rule reloads. */
function useRuleHitCount(ruleId: string, reloadToken: number): number {
  const [hits, setHits] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const poll = () => {
      const request = ++generation;
      void api
        .ruleHits()
        .then((all) => {
          if (active && request === generation) setHits(all[ruleId] ?? 0);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ruleId, reloadToken]);
  return hits;
}

/** Window lifecycle: Esc and the OS close button both flush the pending save,
 *  tell the main window this rule is gone (unlocking its inline editor), then
 *  destroy the window. Returns the Delete handler, which does the same. */
function useDetailWindowClose(
  ruleId: string,
  scenarioId: string,
  editor: Editor,
  setError: (msg: string) => void,
) {
  const closeTaskRef = useRef<Promise<boolean> | null>(null);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  // Reassigned each render so the once-mounted listeners flush the latest edit.
  const closeRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));

  function beginClose(operation: () => Promise<void>, failureMessage: string): Promise<boolean> {
    const active = closeTaskRef.current;
    if (active) return active;
    setClosing(true);
    const task = operation().then(
      () => true,
      (error: unknown) => {
        setError(`${failureMessage} (${error}). The editor was left open so you can retry.`);
        return false;
      },
    );
    closeTaskRef.current = task;
    void task.then((closed) => {
      if (closeTaskRef.current !== task || closed) return;
      closeTaskRef.current = null;
      setClosing(false);
    });
    return task;
  }

  closeRef.current = () => {
    return beginClose(async () => {
      await editor.flush();
      await getCurrentWindow().destroy();
    }, "Rule changes could not be saved or the window could not close");
  };
  const close = useCallback(() => closeRef.current(), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        void close();
      }
    }
    window.addEventListener("keydown", onKey);
    let active = true;
    let unlisten: (() => void) | undefined;
    setReady(false);
    void getCurrentWindow()
      .onCloseRequested((e) => {
        e.preventDefault();
        void close();
      })
      .then((fn) => {
        if (active) {
          unlisten = fn;
          setReady(true);
        } else fn();
      })
      .catch((error) => setError(String(error)));
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, [close, setError]);

  async function handleDelete() {
    await beginClose(async () => {
      editor.clearPending();
      // A save that already entered IPC cannot be cancelled. Let it settle
      // before submitting the delete so async Tauri command scheduling cannot
      // reorder the stale update behind the deletion. Its failure is irrelevant
      // here because deletion deliberately supersedes that editor snapshot.
      await editor.flush().catch(() => {});
      await api.deleteRule(scenarioId, ruleId, {
        label: `Delete rule "${ruleLabel(editor.rule?.matcher.url ?? "")}"`,
      });
      emitRulesChanged(currentRuleWindowLabel(), ruleId);
      await getCurrentWindow().destroy();
    }, "The rule could not be deleted or the window could not close");
  }

  return { handleDelete, close, closing, ready };
}

function ruleEditorPlaceholder(editorReady: boolean, loading: boolean): string {
  if (!editorReady) return "Connecting the detached editor…";
  if (loading) return "Loading rule…";
  return "Rule not found — it may have been deleted.";
}

function RuleWindowContent({
  editorReady,
  editor,
  hits,
  scenarioId,
  onDelete,
}: {
  editorReady: boolean;
  editor: Editor;
  hits: number;
  scenarioId: string;
  onDelete: () => void;
}) {
  const rule = editor.rule;
  if (!editorReady || !rule) {
    return <div className="muted pad">{ruleEditorPlaceholder(editorReady, editor.loading)}</div>;
  }

  return (
    <>
      <RuleEditor rule={rule} hits={hits} onPatch={editor.patch} onDelete={onDelete} />
      <RuleTester
        scenarioId={scenarioId}
        seedMethod={rule.matcher.method ?? undefined}
        seedUrl={rule.matcher.url || undefined}
      />
    </>
  );
}

/**
 * The standalone rule editor shown in a detached OS window (issue #72). Loaded by
 * `main.tsx` when the URL carries `?rule=&scenario=`. It reuses the exact same
 * `RuleEditor` + autosave hook as the inline pane, but talks straight to IPC and
 * broadcasts every change (scoped by rule id) so the main window — which has
 * locked this rule's inline editor — stays in sync.
 */
export function RuleDetailWindow({ ruleId, scenarioId }: { ruleId: string; scenarioId: string }) {
  const label = currentRuleWindowLabel();
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((value: unknown) => setError(String(value)), []);
  const { reloadToken, ready: syncReady } = useExternalReloadToken(label, ruleId, reportError);

  const load = (id: string): Promise<Rule | null> =>
    api.getRule(id).catch((e) => {
      setError(String(e));
      return null;
    });

  const update = async (sid: string, rule: Rule, tag?: HistoryTag) => {
    try {
      const summary = await api.updateRule(
        sid,
        rule,
        tag ?? {
          label: `Edit rule "${ruleLabel(rule.matcher.url)}"`,
          coalesceKey: `rule:${rule.id}`,
        },
      );
      emitRulesChanged(label, rule.id);
      return summary;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  const editor = useSelectedRule(scenarioId, ruleId, load, update, reloadToken);
  const {
    handleDelete,
    close,
    closing,
    ready: closeReady,
  } = useDetailWindowClose(ruleId, scenarioId, editor, setError);
  const hits = useRuleHitCount(ruleId, reloadToken);
  useRememberWindowSize();
  const [flushReady, setFlushReady] = useState(false);
  const flushEditor = editor.flush;

  // The main window owns process exit. Register this editor in its shutdown
  // barrier so an app close cannot terminate a pending debounced rule save.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    setFlushReady(false);
    void onRuleWindowsFlushRequested(ruleId, async (closeAfterFlush) => {
      if (!closeAfterFlush) {
        await flushEditor();
        return;
      }
      if (!(await close())) throw new Error("The detached rule editor could not close safely.");
    })
      .then((fn) => {
        if (active) {
          unlisten = fn;
          setFlushReady(true);
        } else fn();
      })
      .catch((setupError) => setError(String(setupError)));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [close, flushEditor, ruleId]);

  const editorReady = syncReady && closeReady && flushReady;

  // Keep the OS window title in step with the rule's URL (rules have no name).
  const title = editor.rule ? ruleLabel(editor.rule.matcher.url) : "";
  useEffect(() => {
    void getCurrentWindow().setTitle(title || "Rule");
  }, [title]);

  return (
    <div className="rule-window" inert={closing} aria-busy={closing}>
      {error && <div className="error-bar">{error}</div>}
      <div className="rule-window-body">
        <RuleWindowContent
          editorReady={editorReady}
          editor={editor}
          hits={hits}
          scenarioId={scenarioId}
          onDelete={() => void handleDelete()}
        />
      </div>
    </div>
  );
}
