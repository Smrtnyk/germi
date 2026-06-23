import { useEffect } from "react";

import { systemIpc } from "./systemIpc";
import { useTauriListen } from "./useTauriListen";

/**
 * Wayland global hotkey via the backend's `GlobalShortcuts` portal binding.
 * Pushes the desired accelerator to the backend (which binds it through the
 * portal) and runs `action` when the portal reports the shortcut fired. An
 * empty accelerator unbinds; a `hotkey-error` event surfaces a bind failure
 * (e.g. the desktop rejecting the app id). The X11/Windows path uses
 * `useGlobalHotkey`.
 */
export function usePortalHotkey(
  accelerator: string,
  action: () => void,
  onError: (message: string) => void,
): void {
  useEffect(() => {
    void systemIpc.applyPortalHotkey(accelerator).catch((e) => onError(String(e)));
  }, [accelerator, onError]);

  useTauriListen("hotkey-fired", action);
  useTauriListen<string>("hotkey-error", onError);
}
