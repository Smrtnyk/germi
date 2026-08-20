import { emit, listen } from "@tauri-apps/api/event";

import { api } from "./ipc";
import { applyAppearance } from "./theme";
import { announceThemeSyncReady, PREVIEW_ACCEPTED, PREVIEW_CLEARED } from "./settingsWindowEvents";
import type { AcceptedSettingsPreview, ClearedSettingsPreview } from "./settingsWindowProtocol";
import { ThemeLayers } from "./themeLayers";

/**
 * Keeps every window's theme and highlight colors in step with the saved
 * settings. `main.tsx` runs the init before rendering each window (main,
 * compare, rule editors and scripts), and whoever saves settings broadcasts
 * SETTINGS_CHANGED so the others re-read and re-apply.
 */
const SETTINGS_CHANGED = "germi://settings-changed";
let refreshGeneration = 0;
const layers = new ThemeLayers();

export function emitSettingsChanged(): void {
  void emit(SETTINGS_CHANGED, null);
}

async function refreshAppearance(): Promise<void> {
  const generation = ++refreshGeneration;
  const settings = await api.getSettings();
  if (generation !== refreshGeneration) return;
  const appearance = layers.setDurable({
    theme: settings.theme,
    highlightColors: settings.highlightColors,
  });
  if (appearance) applyAppearance(appearance.theme, appearance.highlightColors);
}

/** Apply this window's durable appearance before React renders and follow later
 *  settings saves. Failures outside Tauri keep the cached/default theme. */
export async function initThemeSync(): Promise<void> {
  try {
    await listen(SETTINGS_CHANGED, () => {
      void refreshAppearance().catch(() => undefined);
    });
    await listen<AcceptedSettingsPreview>(PREVIEW_ACCEPTED, ({ payload }) => {
      const appearance = layers.acceptPreview(payload);
      if (appearance) applyAppearance(appearance.theme, appearance.highlightColors);
    });
    await listen<ClearedSettingsPreview>(PREVIEW_CLEARED, ({ payload }) => {
      const appearance = layers.clearPreview(payload);
      if (appearance) applyAppearance(appearance.theme, appearance.highlightColors);
    });
    await refreshAppearance();
    await announceThemeSyncReady();
  } catch {
    /* not running under Tauri, or settings unavailable — keep cached/default appearance */
  }
}
