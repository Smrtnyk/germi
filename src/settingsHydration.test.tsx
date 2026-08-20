import { beforeEach, describe, expect, it, vi } from "vitest";

import "./styles.css";
import { loadDurableSettings } from "./settingsHydration";
import { applyAppearance } from "./theme";
import type { ProxySettings } from "./types";

const apiMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("./ipc", () => ({ api: apiMocks }));

function settings(theme: ProxySettings["theme"]): ProxySettings {
  return {
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    theme,
    highlightColors: { selected: "#777777ff" },
  };
}

beforeEach(() => {
  apiMocks.getSettings.mockReset();
  document.documentElement.removeAttribute("style");
  applyAppearance("light", {});
});

describe("loadDurableSettings appearance fallback", () => {
  it("replaces a stale startup cache after the earlier theme sync was unavailable", async () => {
    const loaded = settings("dark");
    apiMocks.getSettings.mockResolvedValue(loaded);
    const target = {
      setSettings: vi.fn(),
      setDurableSettings: vi.fn(),
      setSettingsReady: vi.fn(),
      getSettingsMutationGeneration: () => 7,
    };

    await loadDurableSettings(target, 7);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#777777ff");
    expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("");
    expect(target.setDurableSettings).toHaveBeenCalledWith(loaded);
    expect(target.setSettings).toHaveBeenCalledWith(loaded);
    expect(target.setSettingsReady).toHaveBeenCalledOnce();
  });
});
