import { api } from "./ipc";
import { applyAppearance } from "./theme";
import type { ProxySettings } from "./types";

export interface SettingsHydrationTarget {
  setSettings: (settings: ProxySettings) => void;
  setDurableSettings: (settings: ProxySettings) => void;
  setSettingsReady: () => void;
  getSettingsMutationGeneration: () => number;
}

/** Hydrate the authoritative settings snapshot. Appearance is applied here,
 *  rather than only in the earlier theme-sync bootstrap, so a transient event
 *  bridge failure cannot strand this window on a stale startup cache. */
export async function loadDurableSettings(
  target: SettingsHydrationTarget,
  settingsGeneration: number,
): Promise<ProxySettings> {
  const loaded = await api.getSettings();
  if (target.getSettingsMutationGeneration() === settingsGeneration) {
    applyAppearance(loaded.theme, loaded.highlightColors);
    target.setDurableSettings(loaded);
    target.setSettings(loaded);
  }
  target.setSettingsReady();
  return loaded;
}
