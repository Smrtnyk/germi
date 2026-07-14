import { emit, listen } from "@tauri-apps/api/event";

import { api } from "./ipc";
import { applyHighlightColors } from "./theme";

/**
 * Keeps every window's highlight colors in step with the saved settings
 * (issue #93). `main.tsx` runs the init in each window (main, compare, rule
 * editors — they all load the same bundle), and whoever saves settings
 * broadcasts SETTINGS_CHANGED so the others re-read and re-apply. The same
 * pattern as `compareWindow.ts`'s seed event.
 */
const SETTINGS_CHANGED = "germi://settings-changed";
let refreshGeneration = 0;

export function emitSettingsChanged(): void {
  void emit(SETTINGS_CHANGED, null);
}

async function refreshHighlightColors(): Promise<void> {
  const generation = ++refreshGeneration;
  const colors = (await api.getSettings()).highlightColors;
  if (generation === refreshGeneration) applyHighlightColors(colors);
}

/** Apply this window's overrides on boot and follow later settings saves.
 *  Colors are cosmetic, so failures (e.g. outside a Tauri webview) stay silent. */
export async function initHighlightColorSync(): Promise<void> {
  try {
    await listen(SETTINGS_CHANGED, () => {
      void refreshHighlightColors().catch(() => undefined);
    });
    await refreshHighlightColors();
  } catch {
    /* not running under Tauri, or settings unavailable — keep defaults */
  }
}
