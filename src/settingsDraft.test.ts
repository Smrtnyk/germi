import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SHORTCUTS } from "./shortcuts";
import {
  hasUnsavedSettingsChanges,
  persistSettingsDialogDraft,
  settleSettingsWrite,
  type SettingsDialogDraft,
} from "./settingsDraft";

function draft(): SettingsDialogDraft {
  return {
    settings: {
      excludedHosts: [],
      headerColumns: [],
      port: 9090,
      allowRemote: false,
      maxFlows: 5000,
      captureFilter: [],
      autoStartOnLaunch: true,
      responseDelayMs: 0,
      systemProxyHotkey: "",
      theme: "system",
      highlightColors: {},
    },
    columnOrder: ["method", "url"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "stacked",
    activeSection: "appearance",
  };
}

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe("hasUnsavedSettingsChanges", () => {
  it("ignores section navigation when no setting value changed", () => {
    const saved = draft();

    expect(hasUnsavedSettingsChanges({ ...saved, activeSection: "columns" }, saved)).toBe(false);
  });

  it("detects changes in every dialog-owned store", () => {
    const saved = draft();

    expect(
      hasUnsavedSettingsChanges({ ...saved, settings: { ...saved.settings, port: 7070 } }, saved),
    ).toBe(true);
    expect(
      hasUnsavedSettingsChanges({ ...saved, columnOrder: [...saved.columnOrder].reverse() }, saved),
    ).toBe(true);
    expect(
      hasUnsavedSettingsChanges(
        { ...saved, shortcuts: { ...saved.shortcuts, save: "Mod+Shift+S" } },
        saved,
      ),
    ).toBe(true);
    expect(
      hasUnsavedSettingsChanges(
        { ...saved, autoLayout: saved.autoLayout === "side" ? "stacked" : "side" },
        saved,
      ),
    ).toBe(true);
  });
});

describe("persistSettingsDialogDraft", () => {
  it("writes every local option once before committing the backend snapshot", async () => {
    const store = storage();
    const order: string[] = [];
    store.setItem.mockImplementation((key, value) => {
      order.push(key);
      store.values.set(key, value);
    });
    const persistBackend = vi.fn(() => {
      order.push("backend");
      return Promise.resolve();
    });

    await persistSettingsDialogDraft(store, draft(), persistBackend);

    expect(order).toEqual([
      "germi.columns",
      "germi.shortcuts",
      "germi.autoLayout",
      "germi.settingsSection",
      "backend",
    ]);
    expect(persistBackend).toHaveBeenCalledOnce();
    expect(persistBackend).toHaveBeenCalledWith(draft().settings);
  });

  it("restores every local option when the backend commit fails", async () => {
    const previous = {
      "germi.columns": '["seq","url"]',
      "germi.shortcuts": '{"save":"Ctrl+S"}',
      "germi.autoLayout": "side",
      "germi.settingsSection": "connections",
    };
    const store = storage(previous);

    await expect(
      persistSettingsDialogDraft(store, draft(), () => Promise.reject(new Error("disk full"))),
    ).rejects.toThrow("disk full");

    expect(Object.fromEntries(store.values)).toEqual(previous);
  });

  it("rolls back a partial local write without calling the backend", async () => {
    const previous = { "germi.columns": '["seq"]' };
    const store = storage(previous);
    store.setItem.mockImplementation((key, value) => {
      if (key === "germi.shortcuts") throw new Error("quota exceeded");
      store.values.set(key, value);
    });
    const persistBackend = vi.fn();

    await expect(persistSettingsDialogDraft(store, draft(), persistBackend)).rejects.toThrow(
      "quota exceeded",
    );

    expect(Object.fromEntries(store.values)).toEqual(previous);
    expect(persistBackend).not.toHaveBeenCalled();
  });
});

describe("settleSettingsWrite", () => {
  it("returns a different authoritative readback with the original rejection", async () => {
    const attempted = draft().settings;
    const authoritative = { ...attempted, port: 7070 };
    const rejection = new Error("write rejected");

    const result = await settleSettingsWrite(
      attempted,
      () => Promise.reject(rejection),
      () => Promise.resolve(authoritative),
    );

    expect(result).toEqual({ settings: authoritative, rejection, readBack: true });
  });

  it("accepts a rejected command when its readback contains the attempted snapshot", async () => {
    const attempted = draft().settings;

    const result = await settleSettingsWrite(
      attempted,
      () => Promise.reject(new Error("response lost")),
      () => Promise.resolve(attempted),
    );

    expect(result).toEqual({ settings: attempted, rejection: null, readBack: true });
  });
});
