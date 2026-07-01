import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "../ipc";
import { ruleLabel } from "../autoresponderState";
import type { HistoryTag, Rule } from "../types";
import {
  currentWindowLabel,
  emitRuleWindowClosed,
  emitRuleWindowResized,
  emitRulesChanged,
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
function useExternalReloadToken(label: string, ruleId: string): number {
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void onRulesChanged((p) => {
      if (p.source === label) return;
      if (p.ruleId === null || p.ruleId === ruleId) setReloadToken((t) => t + 1);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [label, ruleId]);
  return reloadToken;
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
  const closing = useRef(false);
  // Reassigned each render so the once-mounted listeners flush the latest edit.
  const closeRef = useRef<() => Promise<void>>(async () => {});
  closeRef.current = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      await editor.flush();
    } catch {
      /* best-effort flush on close */
    }
    emitRuleWindowClosed(ruleId);
    await getCurrentWindow().destroy();
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        void closeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    let active = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((e) => {
        e.preventDefault();
        void closeRef.current();
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, []);

  return async function handleDelete() {
    if (closing.current) return;
    closing.current = true;
    try {
      editor.clearPending();
      await api.deleteRule(scenarioId, ruleId, {
        label: `Delete rule "${ruleLabel(editor.rule?.matcher.url ?? "")}"`,
      });
      emitRuleWindowClosed(ruleId);
      await getCurrentWindow().destroy();
    } catch (e) {
      closing.current = false;
      setError(String(e));
    }
  };
}

/**
 * The standalone rule editor shown in a detached OS window (issue #72). Loaded by
 * `main.tsx` when the URL carries `?rule=&scenario=`. It reuses the exact same
 * `RuleEditor` + autosave hook as the inline pane, but talks straight to IPC and
 * broadcasts every change (scoped by rule id) so the main window — which has
 * locked this rule's inline editor — stays in sync.
 */
export function RuleDetailWindow({ ruleId, scenarioId }: { ruleId: string; scenarioId: string }) {
  const label = currentWindowLabel();
  const [error, setError] = useState<string | null>(null);
  const reloadToken = useExternalReloadToken(label, ruleId);

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
  const handleDelete = useDetailWindowClose(ruleId, scenarioId, editor, setError);
  useRememberWindowSize();

  // Keep the OS window title in step with the rule's URL (rules have no name).
  const title = editor.rule ? ruleLabel(editor.rule.matcher.url) : "";
  useEffect(() => {
    void getCurrentWindow().setTitle(title || "Rule");
  }, [title]);

  return (
    <div className="rule-window">
      {error && <div className="error-bar">{error}</div>}
      <div className="rule-window-body">
        {editor.rule ? (
          <RuleEditor
            rule={editor.rule}
            hits={0}
            onPatch={editor.patch}
            onDelete={() => void handleDelete()}
          />
        ) : (
          <div className="muted pad">
            {editor.loading ? "Loading rule…" : "Rule not found — it may have been deleted."}
          </div>
        )}
        {editor.rule && (
          <RuleTester
            scenarioId={scenarioId}
            seedMethod={editor.rule.matcher.method ?? undefined}
            seedUrl={editor.rule.matcher.url || undefined}
          />
        )}
      </div>
    </div>
  );
}
