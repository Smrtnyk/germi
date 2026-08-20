import { beforeEach, describe, expect, it, vi } from "vitest";

import "./styles.css";
import { applyAppearance } from "./theme";
import { initThemeSync } from "./themeSync";
import type { ProxySettings, Theme } from "./types";

const apiMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const eventMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
  handlers: {} as Record<string, ((event: { payload: unknown }) => void) | undefined>,
}));

vi.mock("./ipc", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/event", () => ({ emit: eventMocks.emit, listen: eventMocks.listen }));

function settings(
  theme: ProxySettings["theme"],
  highlightColors: Record<string, string> = {},
): ProxySettings {
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
    highlightColors,
  };
}

function mockPreferredScheme(initial: Theme) {
  const original = window.matchMedia.bind(window);
  let matches = initial === "dark";
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList;
  const spy = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((media) => (media === query.media ? query : original(media)));
  return {
    set(theme: Theme) {
      matches = theme === "dark";
      const event = { matches, media: query.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    restore() {
      applyAppearance("dark", {});
      spy.mockRestore();
    },
  };
}

function dispatch(name: string, payload: unknown): void {
  const handler = eventMocks.handlers[name];
  if (!handler) throw new Error(`Missing ${name} listener`);
  handler({ payload });
}

beforeEach(() => {
  apiMocks.getSettings.mockReset();
  eventMocks.listen.mockReset();
  eventMocks.emit.mockReset();
  for (const name of Object.keys(eventMocks.handlers)) delete eventMocks.handlers[name];
  eventMocks.listen.mockImplementation((name, handler) => {
    eventMocks.handlers[name] = handler;
    return Promise.resolve(vi.fn());
  });
  document.documentElement.removeAttribute("style");
  applyAppearance("light", {});
});

describe("theme synchronization", () => {
  it("composes System previews with a changing durable fallback without stale application", async () => {
    const scheme = mockPreferredScheme("dark");
    try {
      apiMocks.getSettings.mockResolvedValueOnce(settings("system", { selected: "#ff000080" }));
      await initThemeSync();

      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ff000080");
      expect(eventMocks.listen.mock.calls.map(([name]) => name)).toEqual([
        "germi://settings-changed",
        "germi://settings-preview-accepted",
        "germi://settings-preview-cleared",
      ]);
      expect(eventMocks.emit).toHaveBeenCalledWith("germi://theme-sync-ready", null);

      dispatch("germi://settings-preview-accepted", {
        sessionId: "settings-1",
        epoch: 10_000,
        revision: 1,
        appearance: { theme: "system", highlightColors: { selected: "#ffffff80" } },
      });
      scheme.set("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");
      expect(document.documentElement.style.getPropertyValue("--sel-fg")).toBe("#000000");

      apiMocks.getSettings.mockResolvedValueOnce(settings("light", { selected: "#00ff0080" }));
      dispatch("germi://settings-changed", null);
      await vi.waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalledTimes(2));
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");

      dispatch("germi://settings-preview-accepted", {
        sessionId: "settings-1",
        epoch: 10_000,
        revision: 1,
        appearance: { theme: "dark", highlightColors: { selected: "#00000080" } },
      });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#ffffff80");

      dispatch("germi://settings-preview-cleared", {
        sessionId: "settings-1",
        epoch: 10_000,
        revision: 2,
        durableAppearance: { theme: "light", highlightColors: { selected: "#00ff0080" } },
      });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.getPropertyValue("--sel-bg")).toBe("#00ff0080");
      scheme.set("dark");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(246, 248, 251)");
    } finally {
      scheme.restore();
    }
  });
});
