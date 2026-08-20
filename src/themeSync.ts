import { emit, listen } from "@tauri-apps/api/event";

import { api } from "./ipc";
import { applyAppearance } from "./theme";

/**
 * Keeps every window's theme and highlight colors in step with the saved
 * settings. `main.tsx` runs the init before rendering each window (main,
 * compare, rule editors and scripts), and whoever saves settings broadcasts
 * SETTINGS_CHANGED so the others re-read and re-apply.
 */
const SETTINGS_CHANGED = "germi://settings-changed";
let refreshGeneration = 0;

export function emitSettingsChanged(): void {
  void emit(SETTINGS_CHANGED, null);
}

async function refreshAppearance(): Promise<void> {
  const generation = ++refreshGeneration;
  const settings = await api.getSettings();
  if (generation === refreshGeneration) applyAppearance(settings.theme, settings.highlightColors);
}

/** Apply this window's durable appearance before React renders and follow later
 *  settings saves. Failures outside Tauri keep the cached/default theme. */
export async function initThemeSync(): Promise<void> {
  try {
    await listen(SETTINGS_CHANGED, () => {
      void refreshAppearance().catch(() => undefined);
    });
    await refreshAppearance();
  } catch {
    /* not running under Tauri, or settings unavailable — keep cached/default appearance */
  }
}
