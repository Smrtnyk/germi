import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { onScriptsFlushRequested } from "../scriptWindows";
import { useSafeWindowClose } from "../useSafeWindowClose";
import { useAsyncSubscription } from "../useTauriListen";
import { ScriptsContainer } from "./ScriptsContainer";

/** The scripts editor in a detached OS window (loaded by `main.tsx` on
 *  `?scripts=1`). Reuses the docked tab's container — the right panel is narrow
 *  for code — and while it is open the docked pane goes read-only (single
 *  writer). Esc and the OS close button flush the pending edit, broadcast the
 *  close and destroy the window. The Rust shell observes the actual destroyed
 *  event and then broadcasts so the docked pane unlocks. */
export function ScriptsWindow() {
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [setupError, setSetupError] = useState<string | null>(null);
  const {
    close,
    closing,
    ready: closeReady,
  } = useSafeWindowClose({
    operation: async () => {
      await flushRef.current();
      await getCurrentWindow().destroy();
    },
    onFailure: () =>
      setSetupError("Scripts could not be saved or the editor window could not close."),
    onSetupError: (error) => setSetupError(String(error)),
  });

  useEffect(() => {
    void getCurrentWindow().setTitle("Scripts");
  }, []);

  const flushReady = useAsyncSubscription(
    onScriptsFlushRequested,
    async (closeAfterFlush) => {
      if (!closeAfterFlush) {
        await flushRef.current();
        return;
      }
      if (!(await close())) throw new Error("The detached scripts editor could not close safely.");
    },
    (error) => setSetupError(String(error)),
  );

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
