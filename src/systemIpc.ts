import { invoke } from "@tauri-apps/api/core";

/**
 * System-integration IPC: the taskbar-icon indicator and the global-shortcut
 * backend. Split out of the main `api` hub so the indicator/hotkey hooks don't
 * pile fan-in onto it.
 */
export const systemIpc = {
  setProxyIndicator: (systemProxy: boolean) => invoke<void>("set_proxy_indicator", { systemProxy }),
  globalShortcutMode: () => invoke<"portal" | "plugin">("global_shortcut_mode"),
  applyPortalHotkey: (accel: string) => invoke<void>("apply_portal_hotkey", { accel }),
};
