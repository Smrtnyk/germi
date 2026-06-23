import { useEffect, useState } from "react";

import { systemIpc } from "./systemIpc";

/**
 * Which global-shortcut backend is active: the portal on Wayland (X11 grabs
 * don't fire there), the plugin on X11/Windows. `null` until resolved.
 */
export function useHotkeyMode(): "portal" | "plugin" | null {
  const [mode, setMode] = useState<"portal" | "plugin" | null>(null);
  useEffect(() => {
    void systemIpc
      .globalShortcutMode()
      .then(setMode)
      .catch(() => setMode("plugin"));
  }, []);
  return mode;
}
