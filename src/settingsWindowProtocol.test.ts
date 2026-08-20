import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthoritativeSettingsPreviewReset,
  createSettingsPreviewOwner,
  createSettingsRequestOwner,
  type SettingsWindowRequest,
  type SettingsWindowResult,
  type SettingsWindowState,
} from "./settingsWindowProtocol";
import {
  SettingsWindowSession,
  type SettingsWindowSessionTransport,
} from "./settingsWindowSession";
import { ThemeLayers } from "./themeLayers";

function request(requestId: string, sessionId = "session-1"): SettingsWindowRequest {
  return { sessionId, requestId, action: { kind: "getExportSections" } };
}

afterEach(() => vi.unstubAllGlobals());

function transportHarness() {
  const order: string[] = [];
  let stateHandler = (_state: SettingsWindowState) => {};
  let resultHandler = (_result: SettingsWindowResult) => {};
  let shutdownHandler = (_request: { sessionId: string; requestId: string }) => {};
  const transport: SettingsWindowSessionTransport = {
    onState: (handler) => {
      order.push("state-listener");
      stateHandler = handler;
      return Promise.resolve(() => {});
    },
    onResult: (handler) => {
      order.push("result-listener");
      resultHandler = handler;
      return Promise.resolve(() => {});
    },
    onShutdown: (handler) => {
      order.push("shutdown-listener");
      shutdownHandler = handler;
      return Promise.resolve(() => {});
    },
    announceReady: () => {
      order.push("ready");
      return Promise.resolve();
    },
    request: vi.fn(() => Promise.resolve()),
  };
  return {
    transport,
    order,
    stateHandler: () => stateHandler,
    resultHandler: () => resultHandler,
    shutdownHandler: () => shutdownHandler,
  };
}

describe("SettingsRequestOwner", () => {
  it("rejects stale, duplicate and overlapping requests deterministically", () => {
    const owner = createSettingsRequestOwner();
    owner.activate("session-1");
    expect(owner.begin(request("one"))).toBeNull();
    expect(owner.begin(request("one"))).toContain("already handled");
    expect(owner.begin(request("two"))).toContain("already in progress");
    expect(owner.begin(request("stale", "old-session"))).toContain("no longer current");
    owner.finish(request("one"));
    expect(owner.begin(request("three"))).toBeNull();
  });
});

describe("Settings preview layers", () => {
  it("rejects stale revisions, suppresses duplicates and restores the newest durable fallback", () => {
    const owner = createSettingsPreviewOwner();
    const layers = new ThemeLayers();
    const saved = { theme: "system" as const, highlightColors: { selected: "saved" } };
    expect(layers.setDurable(saved)).toEqual(saved);
    expect(layers.setDurable(saved)).toBeNull();
    owner.activate("session-1");
    const accepted = owner.accept({
      sessionId: "session-1",
      revision: 2,
      appearance: { theme: "light", highlightColors: { selected: "draft" } },
    });
    expect(accepted).not.toBeNull();
    expect(layers.acceptPreview(accepted!)).toEqual({
      theme: "light",
      highlightColors: { selected: "draft" },
    });
    expect(
      owner.accept({
        sessionId: "session-1",
        revision: 1,
        appearance: { theme: "dark", highlightColors: { selected: "stale" } },
      }),
    ).toBeNull();
    const newSaved = { theme: "dark" as const, highlightColors: { selected: "new saved" } };
    expect(layers.setDurable(newSaved)).toBeNull();
    const cleared = owner.clear(newSaved);
    expect(
      owner.accept({
        sessionId: "session-1",
        revision: 99,
        appearance: { theme: "light", highlightColors: { selected: "late" } },
      }),
    ).toBeNull();
    expect(layers.clearPreview(cleared!)).toEqual(newSaved);
    expect(layers.acceptPreview(accepted!)).toBeNull();
  });

  it("uses a newer recovery epoch to clear a preview left by a lost main webview", () => {
    const lostEpoch = Date.now() * 1000 + 10_000;
    const values = new Map([["germi.settingsPreviewEpoch", String(lostEpoch)]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const layers = new ThemeLayers();
    const durable = { theme: "light" as const, highlightColors: { selected: "durable" } };
    const oldPreview = {
      sessionId: "lost-session",
      epoch: lostEpoch,
      revision: 1,
      appearance: { theme: "dark" as const, highlightColors: { selected: "orphaned" } },
    };
    layers.setDurable(durable);
    expect(layers.acceptPreview(oldPreview)).toEqual(oldPreview.appearance);

    const reset = createAuthoritativeSettingsPreviewReset(durable);
    expect(reset.epoch).toBe(lostEpoch + 1);
    expect(layers.clearPreview(reset)).toEqual(durable);
    expect(
      layers.acceptPreview({
        ...oldPreview,
        revision: oldPreview.revision + 100,
        appearance: { theme: "dark", highlightColors: { selected: "late old preview" } },
      }),
    ).toBeNull();
  });
});

describe("SettingsWindowSession", () => {
  it("installs every listener before announcing readiness", async () => {
    const harness = transportHarness();
    const session = new SettingsWindowSession({
      sessionId: "session-1",
      transport: harness.transport,
      onState: vi.fn(),
      onShutdown: vi.fn(),
      onError: vi.fn(),
    });
    await session.start();
    expect(harness.order).toEqual([
      "state-listener",
      "result-listener",
      "shutdown-listener",
      "ready",
    ]);
    session.dispose();
  });

  it("ignores stale results and settles the matching request once", async () => {
    const harness = transportHarness();
    const session = new SettingsWindowSession({
      sessionId: "session-1",
      transport: harness.transport,
      onState: vi.fn(),
      onShutdown: vi.fn(),
      onError: vi.fn(),
      requestId: () => "request-1",
    });
    await session.start();
    const pending = session.request({ kind: "getExportSections" });
    harness.resultHandler()({ sessionId: "old", requestId: "request-1", ok: true });
    harness.resultHandler()({ sessionId: "session-1", requestId: "other", ok: true });
    harness.resultHandler()({ sessionId: "session-1", requestId: "request-1", ok: true });
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: "request-1" });
    session.dispose();
  });

  it("keeps picker-backed requests pending past ten seconds and accepts the late result", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness();
      const session = new SettingsWindowSession({
        sessionId: "session-1",
        transport: harness.transport,
        onState: vi.fn(),
        onShutdown: vi.fn(),
        onError: vi.fn(),
        requestId: () => "picker-1",
        timeoutMs: 10_000,
      });
      await session.start();
      harness.stateHandler()({
        sessionId: "session-1",
        snapshot: {} as SettingsWindowState["snapshot"],
      });
      const pending = session.request({ kind: "peekImport" });

      await vi.advanceTimersByTimeAsync(10_001);
      harness.resultHandler()({
        sessionId: "session-1",
        requestId: "picker-1",
        ok: true,
        sections: [],
      });

      await expect(pending).resolves.toMatchObject({ ok: true, requestId: "picker-1" });
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still bounds noninteractive requests when their result is lost", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness();
      const session = new SettingsWindowSession({
        sessionId: "session-1",
        transport: harness.transport,
        onState: vi.fn(),
        onShutdown: vi.fn(),
        onError: vi.fn(),
        requestId: () => "bounded-1",
        timeoutMs: 10_000,
      });
      await session.start();
      harness.stateHandler()({
        sessionId: "session-1",
        snapshot: {} as SettingsWindowState["snapshot"],
      });
      const pending = session.request({ kind: "getExportSections" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("did not confirm"),
      });
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an indefinitely pending picker request when the window disposes", async () => {
    const harness = transportHarness();
    const session = new SettingsWindowSession({
      sessionId: "session-1",
      transport: harness.transport,
      onState: vi.fn(),
      onShutdown: vi.fn(),
      onError: vi.fn(),
      requestId: () => "picker-1",
    });
    await session.start();
    const pending = session.request({ kind: "exportCa" });
    session.dispose();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("closed before the operation completed"),
    });
  });
});
