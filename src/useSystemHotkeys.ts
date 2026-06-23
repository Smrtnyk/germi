import { useGlobalHotkey } from "./useGlobalHotkey";
import { useHotkeyMode } from "./useHotkeyMode";
import { usePortalHotkey } from "./usePortalHotkey";

/**
 * Drive the right global-shortcut backend for the system-proxy toggle — the
 * portal on Wayland, the plugin on X11/Windows — keeping the inactive one
 * unbound. The accelerator is shared; only the matching backend registers it.
 */
export function useSystemHotkeys(
  accelerator: string,
  toggleSystemProxy: () => void,
  onError: (message: string) => void,
): void {
  const mode = useHotkeyMode();
  useGlobalHotkey(mode === "plugin" ? accelerator : "", toggleSystemProxy, onError);
  usePortalHotkey(mode === "portal" ? accelerator : "", toggleSystemProxy, onError);
}
