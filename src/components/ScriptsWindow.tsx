import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { closeScriptsEditorWindow } from "../scriptsClose";
import { onScriptsFlushRequested } from "../scriptWindows";
import { ScriptsContainer } from "./ScriptsContainer";

/** The scripts editor in a detached OS window (loaded by `main.tsx` on
 *  `?scripts=1`). Reuses the docked tab's container — the right panel is narrow
 *  for code — and while it is open the docked pane goes read-only (single
 *  writer). Esc and the OS close button flush the pending edit, broadcast the
 *  close and destroy the window. The Rust shell observes the actual destroyed
 *  event and then broadcasts so the docked pane unlocks. */
export function ScriptsWindow() {
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const closeTaskRef = useRef<Promise<boolean> | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeReady, setCloseReady] = useState(false);
  const [flushReady, setFlushReady] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const close = useCallback((): Promise<boolean> => {
    const active = closeTaskRef.current;
    if (active) return active;
    setClosing(true);
    const task = closeScriptsEditorWindow(flushRef.current, () => getCurrentWindow().destroy());
    closeTaskRef.current = task;
    void task.then((closed) => {
      if (closeTaskRef.current !== task || closed) return;
      closeTaskRef.current = null;
      setClosing(false);
      setSetupError("Scripts could not be saved or the editor window could not close.");
    });
    return task;
  }, []);

  useEffect(() => {
    void getCurrentWindow().setTitle("Scripts");
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        void close();
      }
    }
    window.addEventListener("keydown", onKey);
    let alive = true;
    let unlisten: (() => void) | undefined;
    setCloseReady(false);
    void getCurrentWindow()
      .onCloseRequested((e) => {
        e.preventDefault();
        void close();
      })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
          setCloseReady(true);
        } else fn();
      })
      .catch((error) => setSetupError(String(error)));
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, [close]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    setFlushReady(false);
    void onScriptsFlushRequested(async (closeAfterFlush) => {
      if (!closeAfterFlush) {
        await flushRef.current();
        return;
      }
      if (!(await close())) throw new Error("The detached scripts editor could not close safely.");
    })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
          setFlushReady(true);
        } else fn();
      })
      .catch((error) => setSetupError(String(error)));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [close]);

  return (
    <div className="scripts-window" inert={closing} aria-busy={closing}>
      {setupError && closeReady && flushReady && (
        <div className="error-bar" role="alert">
          {setupError}
        </div>
      )}
      {closeReady && flushReady ? (
        <ScriptsContainer flushRef={flushRef} />
      ) : (
        <div className="muted pad">
          {setupError ? `Scripts editor could not start safely: ${setupError}` : "Connecting…"}
        </div>
      )}
    </div>
  );
}
