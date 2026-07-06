import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ScriptsContainer } from "./ScriptsContainer";

/** The scripts editor in a detached OS window (loaded by `main.tsx` on
 *  `?scripts=1`). Reuses the docked tab's container — the right panel is narrow
 *  for code — and stays in sync with it via the scripts-changed broadcast. Esc
 *  closes the window (a pending edit is flushed on unmount). */
export function ScriptsWindow() {
  useEffect(() => {
    void getCurrentWindow().setTitle("Scripts");
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        void getCurrentWindow().destroy();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="scripts-window">
      <ScriptsContainer />
    </div>
  );
}
