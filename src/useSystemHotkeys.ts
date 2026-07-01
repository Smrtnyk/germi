import { useGlobalHotkey } from "./useGlobalHotkey";
import { useHotkeyMode } from "./useHotkeyMode";
import { usePortalHotkey } from "./usePortalHotkey";

/**
 * Drive the right global-shortcut backend for the system-proxy toggle — the
 * portal on Wayland, the plugin on X11/Windows — keeping the inactive one
 * unbound. The accelerator is shared; only the matching backend registers it.
 * `enabled` is false in viewer mode, where there's no proxy to route.
 */
export function useSystemHotkeys(
  accelerator: string,
  toggleSystemProxy: () => void,
  onError: (message: string) => void,
  enabled = true,
): void {
  const mode = useHotkeyMode();
  const accel = enabled ? accelerator : "";
  useGlobalHotkey(mode === "plugin" ? accel : "", toggleSystemProxy, onError);
  usePortalHotkey(mode === "portal" ? accel : "", toggleSystemProxy, onError);
}
