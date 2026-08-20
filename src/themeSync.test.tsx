import { beforeEach, describe, expect, it, vi } from "vitest";

import "./styles.css";
import { applyAppearance } from "./theme";
import { initThemeSync } from "./themeSync";
import type { ProxySettings } from "./types";

const apiMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const eventMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
  handler: undefined as undefined | ((event: { payload: null }) => void),
}));

vi.mock("./ipc", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/event", () => ({ emit: eventMocks.emit, listen: eventMocks.listen }));

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
    highlightColors: {},
  };
}

beforeEach(() => {
  apiMocks.getSettings.mockReset();
  eventMocks.listen.mockReset();
  eventMocks.handler = undefined;
  eventMocks.listen.mockImplementation((_name, handler) => {
    eventMocks.handler = handler;
    return Promise.resolve(vi.fn());
  });
  document.documentElement.removeAttribute("style");
  applyAppearance("light", {});
});

describe("theme synchronization", () => {
  it("applies startup settings and propagates a later save into this app window", async () => {
    apiMocks.getSettings.mockResolvedValueOnce(settings("dark"));
    await initThemeSync();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(eventMocks.listen).toHaveBeenCalledWith(
      "germi://settings-changed",
      expect.any(Function),
    );

    apiMocks.getSettings.mockResolvedValueOnce(settings("light"));
    eventMocks.handler?.({ payload: null });

    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(246, 248, 251)");
  });
});
