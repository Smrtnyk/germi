import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { SettingsDialogDraft } from "./settingsDraft";
import { DEFAULT_FILTER_COLOR_PRESETS } from "./filterColorPresets";
import { baselineFromSnapshot } from "./settingsReconciliation";
import type { SettingsWindowSnapshot } from "./settingsWindowProtocol";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
import type { ProxySettings } from "./types";

const eventMocks = vi.hoisted(() => {
  const handlers: Record<string, ((payload: unknown) => void) | undefined> = {};
  const subscribe = (name: string) =>
    vi.fn((handler: (payload: unknown) => void) => {
      handlers[name] = handler;
      return Promise.resolve(() => {
        if (handlers[name] === handler) delete handlers[name];
      });
    });
  return {
    handlers,
    ready: subscribe("ready"),
    operation: subscribe("operation"),
    preview: subscribe("preview"),
    previewResume: subscribe("previewResume"),
    themeReady: subscribe("themeReady"),
    shutdownResult: subscribe("shutdownResult"),
    closed: subscribe("closed"),
    sendState: vi.fn((_payload: unknown) => Promise.resolve()),
    sendResult: vi.fn((_payload: unknown) => Promise.resolve()),
    broadcastPreview: vi.fn((_payload: unknown) => Promise.resolve()),
    broadcastCleared: vi.fn((_payload: unknown) => Promise.resolve()),
    requestShutdown: vi.fn((_payload: { sessionId: string; requestId: string }) =>
      Promise.resolve(),
    ),
  };
});

const windowMocks = vi.hoisted(() => ({
  sessionId: null as string | null,
  replaceOrphan: false,
  open: vi.fn(
    async (
      begin: () => string,
      _active: () => string | null,
      recoverOrphan: () => Promise<void>,
    ) => {
      if (windowMocks.replaceOrphan) await recoverOrphan();
      windowMocks.sessionId = begin();
      return windowMocks.replaceOrphan ? ("replaced" as const) : ("created" as const);
    },
  ),
  isOpen: vi.fn(() => Promise.resolve(true)),
  destroy: vi.fn(() => Promise.resolve()),
}));

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSettingsSections: vi.fn(),
  exportSettings: vi.fn(),
  peekSettingsImport: vi.fn(),
  applySettingsImport: vi.fn(),
  exportCa: vi.fn(),
  regenerateCa: vi.fn(),
}));

vi.mock("./settingsWindowEvents", () => ({
  onSettingsWindowReady: eventMocks.ready,
  onSettingsOperation: eventMocks.operation,
  onSettingsPreviewRequest: eventMocks.preview,
  onSettingsPreviewResume: eventMocks.previewResume,
  onThemeSyncReady: eventMocks.themeReady,
  onSettingsShutdownResult: eventMocks.shutdownResult,
  onSettingsWindowClosed: eventMocks.closed,
  sendSettingsWindowState: eventMocks.sendState,
  sendSettingsOperationResult: eventMocks.sendResult,
  broadcastSettingsPreview: eventMocks.broadcastPreview,
  broadcastSettingsPreviewCleared: eventMocks.broadcastCleared,
  requestSettingsShutdown: eventMocks.requestShutdown,
}));

vi.mock("./settingsWindow", () => ({
  openOrFocusSettingsWindow: windowMocks.open,
  isSettingsWindowOpen: windowMocks.isOpen,
  destroySettingsWindowFromMain: windowMocks.destroy,
}));

vi.mock("./ipc", () => ({ api: apiMocks }));

import { useSettingsWindowController } from "./useSettingsWindowController";

function settings(overrides: Partial<ProxySettings> = {}): ProxySettings {
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
    theme: "dark",
    highlightColors: { selected: "saved" },
    filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
    ...overrides,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    ready: false,
    settings: settings(),
    getDurableSettings: vi.fn(() => settings()),
    columnOrder: ["seq", "method"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "side" as const,
    running: false,
    portError: null,
    save: vi.fn((value: SettingsDialogDraft) => Promise.resolve(value)),
    flush: vi.fn(() => Promise.resolve()),
    applyImported: vi.fn((value: ProxySettings) => Promise.resolve(value)),
    refreshCa: vi.fn(),
    clearListenerError: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

function dispatch(name: string, payload: unknown): void {
  const handler = eventMocks.handlers[name];
  if (!handler) throw new Error(`Missing ${name} listener`);
  handler(payload);
}

async function openController(overrides: Record<string, unknown> = {}) {
  const controllerOptions = options(overrides);
  const hook = await renderHook(() => useSettingsWindowController(controllerOptions));
  await vi.waitFor(() => expect(eventMocks.handlers.operation).toBeTypeOf("function"));
  hook.result.current.open();
  await vi.waitFor(() => expect(windowMocks.sessionId).not.toBeNull());
  return { hook, controllerOptions, sessionId: windowMocks.sessionId! };
}

async function seedController(sessionId: string): Promise<SettingsWindowSnapshot> {
  dispatch("ready", { sessionId });
  await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalled());
  const state = eventMocks.sendState.mock.calls[eventMocks.sendState.mock.calls.length - 1][0] as {
    snapshot: SettingsWindowSnapshot;
  };
  return state.snapshot;
}

function draft(value: ProxySettings): SettingsDialogDraft {
  return {
    settings: value,
    columnOrder: ["method", "seq"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "stacked",
    activeSection: "appearance",
  };
}

describe("main-owned Settings window controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of Object.keys(eventMocks.handlers)) delete eventMocks.handlers[name];
    windowMocks.sessionId = null;
    windowMocks.replaceOrphan = false;
    windowMocks.isOpen.mockResolvedValue(true);
  });

  it("seeds only the active session and performs a save in the main window", async () => {
    const { controllerOptions, sessionId } = await openController();
    dispatch("ready", { sessionId: "stale" });
    expect(eventMocks.sendState).not.toHaveBeenCalled();
    const baseline = await seedController(sessionId);

    const saved = settings({
      port: 9090,
      theme: "light",
      highlightColors: { selected: "draft" },
      filterColorPresets: ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)],
    });
    dispatch("operation", {
      sessionId,
      requestId: "save-1",
      action: { kind: "save", baseline: baselineFromSnapshot(baseline), draft: draft(saved) },
    });
    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());

    expect(controllerOptions.save).toHaveBeenCalledWith(draft(saved));
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        durableAppearance: { theme: "light", highlightColors: { selected: "draft" } },
      }),
    );
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        requestId: "save-1",
        ok: true,
        snapshot: expect.objectContaining({ settings: saved, activeSection: "appearance" }),
      }),
    );
  });

  it("merges child-only edits onto newer main-owned Settings before saving", async () => {
    const { hook, controllerOptions, sessionId } = await openController();
    const baseline = await seedController(sessionId);
    controllerOptions.settings = settings({
      port: 7070,
      excludedHosts: ["main.example"],
    });
    await hook.rerender();
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledTimes(2));
    const edited = settings({ responseDelayMs: 500 });

    dispatch("operation", {
      sessionId,
      requestId: "save-merged",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(edited),
      },
    });

    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    const merged = settings({
      port: 7070,
      excludedHosts: ["main.example"],
      responseDelayMs: 500,
    });
    expect(controllerOptions.save).toHaveBeenCalledWith(draft(merged));
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        snapshot: expect.objectContaining({ settings: merged }),
      }),
    );
  });

  it("merges a child preset palette with an unrelated main-owned mutation", async () => {
    const { hook, controllerOptions, sessionId } = await openController();
    const baseline = await seedController(sessionId);
    controllerOptions.settings = settings({ excludedHosts: ["main.example"] });
    await hook.rerender();
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledTimes(2));
    const childPresets = ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)];

    dispatch("operation", {
      sessionId,
      requestId: "save-presets-merged",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(settings({ filterColorPresets: childPresets })),
      },
    });

    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    const merged = settings({
      excludedHosts: ["main.example"],
      filterColorPresets: childPresets,
    });
    expect(controllerOptions.save).toHaveBeenCalledWith(draft(merged));
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        snapshot: expect.objectContaining({ settings: merged }),
      }),
    );
  });

  it("returns the converged state produced by a newer queued main save", async () => {
    const newer = settings({
      port: 9090,
      excludedHosts: ["main-only.example"],
      responseDelayMs: 500,
    });
    const save = vi.fn((merged: SettingsDialogDraft) =>
      Promise.resolve({ ...merged, settings: newer }),
    );
    const { sessionId } = await openController({ save });
    const baseline = await seedController(sessionId);

    dispatch("operation", {
      sessionId,
      requestId: "save-converged",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(settings({ port: 9090, responseDelayMs: 500 })),
      },
    });

    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        snapshot: expect.objectContaining({ settings: newer }),
      }),
    );
  });

  it("closes the preview gate before awaiting the successful-save clear broadcast", async () => {
    let releaseClear!: () => void;
    eventMocks.broadcastCleared.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const { sessionId } = await openController();
    const baseline = await seedController(sessionId);

    dispatch("operation", {
      sessionId,
      requestId: "save-with-deferred-clear",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(settings({ theme: "light" })),
      },
    });
    await vi.waitFor(() => expect(eventMocks.broadcastCleared).toHaveBeenCalledOnce());
    dispatch("preview", {
      sessionId,
      revision: 99,
      appearance: { theme: "dark", highlightColors: { selected: "late" } },
    });

    expect(eventMocks.broadcastPreview).not.toHaveBeenCalled();
    expect(eventMocks.sendResult).not.toHaveBeenCalled();
    releaseClear();
    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());

    dispatch("previewResume", { sessionId: "stale" });
    dispatch("preview", {
      sessionId,
      revision: 100,
      appearance: { theme: "dark", highlightColors: { selected: "still terminal" } },
    });
    expect(eventMocks.broadcastPreview).not.toHaveBeenCalled();
    dispatch("previewResume", { sessionId });
    dispatch("preview", {
      sessionId,
      revision: 101,
      appearance: { theme: "light", highlightColors: { selected: "resumed" } },
    });
    await vi.waitFor(() => expect(eventMocks.broadcastPreview).toHaveBeenCalledOnce());
  });

  it("rejects a same-field overlap and returns the newest snapshot without saving", async () => {
    const { hook, controllerOptions, sessionId } = await openController();
    const baseline = await seedController(sessionId);
    controllerOptions.settings = settings({ port: 7070, excludedHosts: ["main.example"] });
    await hook.rerender();
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledTimes(2));

    dispatch("operation", {
      sessionId,
      requestId: "save-conflict",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(settings({ port: 9090 })),
      },
    });

    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    expect(controllerOptions.save).not.toHaveBeenCalled();
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        conflicts: ["settings.port"],
        error: expect.stringContaining("draft was kept open"),
        snapshot: expect.objectContaining({
          settings: expect.objectContaining({ port: 7070, excludedHosts: ["main.example"] }),
        }),
      }),
    );
  });

  it("rejects divergent child and main filter palettes as one atomic field", async () => {
    const { hook, controllerOptions, sessionId } = await openController();
    const baseline = await seedController(sessionId);
    const mainPresets = ["#44556680", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)];
    controllerOptions.settings = settings({ filterColorPresets: mainPresets });
    await hook.rerender();
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledTimes(2));
    const childPresets = ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)];

    dispatch("operation", {
      sessionId,
      requestId: "save-presets-conflict",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(settings({ filterColorPresets: childPresets })),
      },
    });

    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    expect(controllerOptions.save).not.toHaveBeenCalled();
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        conflicts: ["settings.filterColorPresets"],
        snapshot: expect.objectContaining({
          settings: expect.objectContaining({ filterColorPresets: mainPresets }),
        }),
      }),
    );
  });

  it("retains the failed draft while returning the authoritative backend readback", async () => {
    const durable = settings({ port: 7070, highlightColors: { selected: "readback" } });
    apiMocks.getSettings.mockResolvedValue(durable);
    const save = vi.fn(() => Promise.reject(new Error("disk full")));
    const { sessionId } = await openController({ save });
    const baseline = await seedController(sessionId);
    const attempted = settings({ port: 9090, highlightColors: { selected: "attempted" } });

    dispatch("operation", {
      sessionId,
      requestId: "save-failed",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(attempted),
      },
    });
    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledOnce());
    expect(eventMocks.sendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "save-failed",
        ok: false,
        error: "disk full",
        snapshot: expect.objectContaining({ settings: durable }),
      }),
    );

    dispatch("operation", {
      sessionId,
      requestId: "save-failed",
      action: {
        kind: "save",
        baseline: baselineFromSnapshot(baseline),
        draft: draft(attempted),
      },
    });
    await vi.waitFor(() => expect(eventMocks.sendResult).toHaveBeenCalledTimes(2));
    expect(eventMocks.sendResult.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining("already handled") }),
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects stale previews, restores durable appearance on shell close, and clears ownership", async () => {
    const { hook, controllerOptions, sessionId } = await openController();
    dispatch("preview", {
      sessionId,
      revision: 2,
      appearance: { theme: "light", highlightColors: { selected: "draft" } },
    });
    await vi.waitFor(() => expect(eventMocks.broadcastPreview).toHaveBeenCalledOnce());
    dispatch("preview", {
      sessionId,
      revision: 1,
      appearance: { theme: "system", highlightColors: { selected: "stale" } },
    });
    expect(eventMocks.broadcastPreview).toHaveBeenCalledOnce();

    // A main save can be optimistic while its durable write is still pending.
    controllerOptions.settings = settings({
      theme: "light",
      highlightColors: { selected: "optimistic-only" },
    });
    await hook.rerender();
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledOnce());
    eventMocks.sendState.mockClear();

    windowMocks.isOpen.mockResolvedValue(false);
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce());
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        durableAppearance: { theme: "dark", highlightColors: { selected: "saved" } },
      }),
    );
    dispatch("ready", { sessionId });
    expect(eventMocks.sendState).not.toHaveBeenCalled();
  });

  it("rebroadcasts an active preview to a late filter window and reverts it on Settings close", async () => {
    const { controllerOptions, sessionId } = await openController();
    dispatch("preview", {
      sessionId,
      revision: 1,
      appearance: { theme: "light", highlightColors: { selected: "filter-preview" } },
    });
    await vi.waitFor(() => expect(eventMocks.broadcastPreview).toHaveBeenCalledOnce());
    const activePreview = eventMocks.broadcastPreview.mock.calls[0][0];

    eventMocks.broadcastPreview.mockClear();
    dispatch("themeReady", null);
    await vi.waitFor(() => expect(eventMocks.broadcastPreview).toHaveBeenCalledWith(activePreview));

    windowMocks.isOpen.mockResolvedValue(false);
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce());
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        durableAppearance: { theme: "dark", highlightColors: { selected: "saved" } },
      }),
    );
  });

  it("ignores a late unscoped destroy event after a replacement singleton opens", async () => {
    const { controllerOptions } = await openController();
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(windowMocks.isOpen).toHaveBeenCalledOnce());
    expect(controllerOptions.clearListenerError).not.toHaveBeenCalled();

    windowMocks.isOpen.mockResolvedValue(false);
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce());
  });

  it("rechecks session ownership after an asynchronous unscoped-close lookup", async () => {
    let resolveLookup!: (open: boolean) => void;
    windowMocks.isOpen.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const { hook, controllerOptions, sessionId: oldSession } = await openController();
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(windowMocks.isOpen).toHaveBeenCalledOnce());

    hook.result.current.open();
    await vi.waitFor(() => expect(windowMocks.sessionId).not.toBe(oldSession));
    const replacement = windowMocks.sessionId!;
    resolveLookup(false);
    await Promise.resolve();
    dispatch("ready", { sessionId: replacement });

    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledOnce());
    expect(eventMocks.broadcastCleared).not.toHaveBeenCalled();
    expect(controllerOptions.clearListenerError).not.toHaveBeenCalled();
  });

  it("does not let deferred cleanup from an old session clear its replacement", async () => {
    let releaseClear!: () => void;
    eventMocks.broadcastCleared.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const { hook, controllerOptions, sessionId: oldSession } = await openController();
    windowMocks.isOpen.mockResolvedValue(false);
    dispatch("closed", { sessionId: null });
    await vi.waitFor(() => expect(eventMocks.broadcastCleared).toHaveBeenCalledOnce());

    dispatch("preview", {
      sessionId: oldSession,
      revision: 99,
      appearance: { theme: "light", highlightColors: { selected: "late" } },
    });
    expect(eventMocks.broadcastPreview).not.toHaveBeenCalled();

    hook.result.current.open();
    await vi.waitFor(() => expect(windowMocks.sessionId).not.toBe(oldSession));
    const replacement = windowMocks.sessionId!;
    releaseClear();
    await Promise.resolve();
    dispatch("ready", { sessionId: replacement });

    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledOnce());
    expect(controllerOptions.clearListenerError).not.toHaveBeenCalled();
  });

  it("broadcasts an unconditional durable reset when authoritative startup completes", async () => {
    await renderHook(() => useSettingsWindowController(options({ ready: true })));

    await vi.waitFor(() => expect(eventMocks.broadcastCleared).toHaveBeenCalledOnce());
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: null,
        durableAppearance: { theme: "dark", highlightColors: { selected: "saved" } },
      }),
    );
  });

  it("reapplies durable appearance before replacing an orphaned singleton", async () => {
    windowMocks.replaceOrphan = true;

    const { sessionId } = await openController();

    expect(sessionId).toBeTruthy();
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: null,
        durableAppearance: { theme: "dark", highlightColors: { selected: "saved" } },
      }),
    );
  });

  it("reapplies durable appearance for an unowned Rust Destroyed notification", async () => {
    const controllerOptions = options();
    await renderHook(() => useSettingsWindowController(controllerOptions));
    await vi.waitFor(() => expect(eventMocks.handlers.closed).toBeTypeOf("function"));

    dispatch("closed", { sessionId: null });

    await vi.waitFor(() => expect(eventMocks.broadcastCleared).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce());
  });

  it("destroys and reconciles a sessionless orphan during main shutdown", async () => {
    const controllerOptions = options();
    const hook = await renderHook(() => useSettingsWindowController(controllerOptions));

    await expect(hook.result.current.closeForShutdown()).resolves.toBeUndefined();

    expect(windowMocks.destroy).toHaveBeenCalledOnce();
    expect(eventMocks.broadcastCleared).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null }),
    );
    expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce();
  });

  it("destroys an unseeded Settings child immediately during main shutdown", async () => {
    const { hook, controllerOptions } = await openController();
    await expect(hook.result.current.closeForShutdown()).resolves.toBeUndefined();
    expect(windowMocks.destroy).toHaveBeenCalledOnce();
    expect(eventMocks.requestShutdown).not.toHaveBeenCalled();
    expect(controllerOptions.clearListenerError).toHaveBeenCalledOnce();
  });

  it("retains ownership when destroying an unseeded Settings child fails", async () => {
    windowMocks.destroy.mockRejectedValueOnce(new Error("destroy denied"));
    const { hook, controllerOptions, sessionId } = await openController();

    await expect(hook.result.current.closeForShutdown()).rejects.toThrow("destroy denied");

    dispatch("ready", { sessionId });
    await vi.waitFor(() => expect(eventMocks.sendState).toHaveBeenCalledOnce());
    expect(controllerOptions.clearListenerError).not.toHaveBeenCalled();
  });

  it("lets a dirty Settings response cancel the main window close", async () => {
    const { hook, sessionId } = await openController();
    await seedController(sessionId);
    const pending = hook.result.current.closeForShutdown();
    await vi.waitFor(() => expect(eventMocks.requestShutdown).toHaveBeenCalledOnce());
    const rejection = expect(pending).rejects.toThrow("unsaved changes");
    const request = eventMocks.requestShutdown.mock.calls[0][0];
    dispatch("shutdownResult", {
      sessionId,
      requestId: request.requestId,
      ok: false,
      error: "Settings has unsaved changes",
    });
    await rejection;
  });

  it("waits for Rust Destroyed instead of treating a child success reply as shutdown success", async () => {
    const { hook, sessionId } = await openController();
    await seedController(sessionId);
    let settled = false;
    const pending = hook.result.current.closeForShutdown().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(eventMocks.requestShutdown).toHaveBeenCalledOnce());
    const request = eventMocks.requestShutdown.mock.calls[0][0];

    dispatch("shutdownResult", { sessionId, requestId: request.requestId, ok: true });
    await Promise.resolve();
    expect(settled).toBe(false);

    windowMocks.isOpen.mockResolvedValue(false);
    dispatch("closed", { sessionId: null });
    await pending;
    expect(settled).toBe(true);
  });
});
