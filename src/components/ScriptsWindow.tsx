import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { emitScriptsWindowClosed } from "../scriptWindows";
import { ScriptsContainer } from "./ScriptsContainer";

/** The scripts editor in a detached OS window (loaded by `main.tsx` on
 *  `?scripts=1`). Reuses the docked tab's container — the right panel is narrow
 *  for code — and while it is open the docked pane goes read-only (single
 *  writer). Esc and the OS close button flush the pending edit, broadcast the
 *  close so the docked pane unlocks, then destroy the window. */
export function ScriptsWindow() {
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const closing = useRef(false);

  useEffect(() => {
    void getCurrentWindow().setTitle("Scripts");
    async function close() {
      if (closing.current) return;
      closing.current = true;
      await flushRef.current().catch(() => {});
      emitScriptsWindowClosed();
      await getCurrentWindow().destroy();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        void close();
      }
    }
    window.addEventListener("keydown", onKey);
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((e) => {
        e.preventDefault();
        void close();
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, []);

  return (
    <div className="scripts-window">
      <ScriptsContainer flushRef={flushRef} />
    </div>
  );
}
