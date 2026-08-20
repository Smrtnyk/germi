import { beforeEach, describe, expect, it, vi } from "vitest";

import defaultCapability from "../src-tauri/capabilities/default.json";

const mocks = vi.hoisted(() => ({
  existing: vi.fn(),
  focus: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  constructors: [] as { label: string; options: Record<string, unknown> }[],
  created: null as (() => void) | null,
  error: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: mocks.destroy }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = mocks.existing;

    constructor(label: string, options: Record<string, unknown>) {
      mocks.constructors.push({ label, options });
    }

    once(event: string, handler: (event: { payload: unknown }) => void) {
      if (event === "tauri://created") mocks.created = () => handler({ payload: null });
      if (event === "tauri://error") mocks.error = handler;
      return Promise.resolve(() => {});
    }
  },
}));

import {
  closeSettingsWindow,
  destroySettingsWindowFromMain,
  openOrFocusSettingsWindow,
  SETTINGS_WINDOW_LABEL,
  SETTINGS_WINDOW_OPTIONS,
} from "./settingsWindow";

describe("Settings native window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.constructors.length = 0;
    mocks.created = null;
    mocks.error = null;
    mocks.existing.mockResolvedValue(null);
  });

  it("creates one unparented, modeless, movable singleton with a session route", async () => {
    const begin = vi.fn(() => "session one");
    const first = openOrFocusSettingsWindow(begin, () => null);
    const second = openOrFocusSettingsWindow(begin, () => null);
    await vi.waitFor(() => expect(mocks.created).not.toBeNull());
    expect(mocks.constructors).toEqual([
      {
        label: SETTINGS_WINDOW_LABEL,
        options: {
          ...SETTINGS_WINDOW_OPTIONS,
          url: "index.html?settings=session%20one",
        },
      },
    ]);
    expect(mocks.constructors[0].options).not.toHaveProperty("parent");
    expect(begin).toHaveBeenCalledOnce();
    expect(defaultCapability.windows).toContain(SETTINGS_WINDOW_LABEL);
    mocks.created?.();
    await expect(first).resolves.toBe("created");
    await expect(second).resolves.toBe("created");
  });

  it("leaves detached Appearance hue-copy and Columns HTML5 drag/drop reachable on Windows", async () => {
    const opened = openOrFocusSettingsWindow(
      () => "drag-drop-session",
      () => null,
    );
    await vi.waitFor(() => expect(mocks.created).not.toBeNull());

    // WebView2's native file-drop handler must be disabled for the DOM drag
    // handlers covered by AppearanceSettings and ColumnsSettings tests to run.
    expect(mocks.constructors[0].options.dragDropEnabled).toBe(false);

    mocks.created?.();
    await expect(opened).resolves.toBe("created");
  });

  it("focuses the existing instance without starting a new session", async () => {
    mocks.existing.mockResolvedValue({ setFocus: mocks.focus });
    const begin = vi.fn(() => "unused");
    await expect(openOrFocusSettingsWindow(begin, () => "active-session")).resolves.toBe("focused");
    expect(begin).not.toHaveBeenCalled();
    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(mocks.constructors).toEqual([]);
  });

  it("replaces an orphaned singleton when this main webview owns no session", async () => {
    mocks.existing.mockResolvedValue({ destroy: mocks.destroy });
    const begin = vi.fn(() => "replacement-session");
    const recover = vi.fn(() => Promise.resolve());
    const opened = openOrFocusSettingsWindow(begin, () => null, recover);
    await vi.waitFor(() => expect(mocks.created).not.toBeNull());
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.invocationCallOrder[0]).toBeLessThan(begin.mock.invocationCallOrder[0]);
    expect(begin).toHaveBeenCalledOnce();
    expect(mocks.constructors[0]).toMatchObject({
      label: SETTINGS_WINDOW_LABEL,
      options: { url: "index.html?settings=replacement-session" },
    });
    mocks.created?.();
    await expect(opened).resolves.toBe("replaced");
  });

  it("returns focus to main before destroying the Settings window", async () => {
    mocks.existing.mockResolvedValue({ setFocus: mocks.focus });
    await closeSettingsWindow();
    expect(mocks.focus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.destroy.mock.invocationCallOrder[0],
    );
  });

  it("still destroys Settings when restoring main focus fails", async () => {
    mocks.focus.mockRejectedValueOnce(new Error("main is closing"));
    mocks.existing.mockResolvedValue({ setFocus: mocks.focus });
    await expect(closeSettingsWindow()).resolves.toBeUndefined();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("still destroys Settings when looking up the main window fails", async () => {
    mocks.existing.mockRejectedValueOnce(new Error("main webview unavailable"));

    await expect(closeSettingsWindow()).resolves.toBeUndefined();

    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("propagates actual Settings destruction failure", async () => {
    mocks.existing.mockResolvedValue({ setFocus: mocks.focus });
    mocks.destroy.mockRejectedValueOnce(new Error("destroy denied"));

    await expect(closeSettingsWindow()).rejects.toThrow("destroy denied");
  });

  it("destroys an orphaned Settings singleton during main unmount cleanup", async () => {
    mocks.existing.mockResolvedValue({ destroy: mocks.destroy });
    await destroySettingsWindowFromMain();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
