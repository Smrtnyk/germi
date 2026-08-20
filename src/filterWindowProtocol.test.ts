import { describe, expect, it, vi } from "vitest";

import { FilterPreviewOwner } from "./filterPreviewProtocol";
import { createFilterSaveOwner } from "./filterSaveOwner";
import type {
  FilterSaveRequest,
  FilterSaveResult,
  FilterWindowState,
} from "./filterWindowProtocol";
import { FilterWindowSession, type FilterWindowSessionTransport } from "./filterWindowSession";
import { DEFAULT_FILTER_COLOR_PRESETS } from "./filterColorPresets";
import type { FilterDraft, PreparedFilterDraft, SavedFilter } from "./savedFilters";

const draft: FilterDraft = {
  query: "host:api.example",
  kinds: [],
  statuses: ["4xx"],
  color: "#AABBCC",
  opacity: 47.6,
  highlight: true,
};

function saved(filter: PreparedFilterDraft, id = "saved-1"): SavedFilter {
  return { id, ...filter };
}

function request(overrides: Partial<FilterSaveRequest> = {}): FilterSaveRequest {
  return { sessionId: "session-1", requestId: "request-1", draft, only: false, ...overrides };
}

function transportHarness() {
  let stateHandler = (_state: FilterWindowState) => {};
  let resultHandler = (_result: FilterSaveResult) => {};
  const order: string[] = [];
  const transport: FilterWindowSessionTransport = {
    onState: (handler) => {
      order.push("state-listener");
      stateHandler = handler;
      return Promise.resolve(vi.fn(() => {}));
    },
    onSaveResult: (handler) => {
      order.push("result-listener");
      resultHandler = handler;
      return Promise.resolve(vi.fn(() => {}));
    },
    requestState: () => {
      order.push("ready");
      return Promise.resolve();
    },
    requestSave: vi.fn(() => Promise.resolve()),
  };
  return {
    transport,
    order,
    state: (payload: FilterWindowState) => stateHandler(payload),
    result: (payload: FilterSaveResult) => resultHandler(payload),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FilterSaveOwner", () => {
  it("replays repeated request ids and rejects stale sessions without saving twice", () => {
    const owner = createFilterSaveOwner();
    const save = vi.fn((filter: PreparedFilterDraft) => saved(filter));
    owner.activateSession("session-1");
    const first = owner.handle(request(), save);
    const repeated = owner.handle(request(), save);
    const stale = owner.handle(request({ sessionId: "stale", requestId: "request-2" }), save);
    expect(first.ok).toBe(true);
    expect(repeated).toEqual(first);
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("no longer current") });
    expect(save).toHaveBeenCalledOnce();
  });

  it("acknowledges a semantic retry but rejects a changed draft after the first save", () => {
    const owner = createFilterSaveOwner();
    const save = vi.fn((filter: PreparedFilterDraft) => saved(filter));
    owner.syncFilters([]);
    owner.activateSession("session-1");
    const first = owner.handle(request(), save);
    const second = owner.handle(request({ requestId: "request-2" }), save);
    const changed = owner.handle(
      request({
        requestId: "request-3",
        draft: { ...draft, query: "host:different.example" },
      }),
      save,
    );
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, requestId: "request-2" });
    expect(changed).toMatchObject({
      ok: false,
      saved: true,
      error: expect.stringContaining("already saved"),
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("normalizes color and selected opacity through the shared draft boundary", () => {
    const owner = createFilterSaveOwner();
    const save = vi.fn((filter: PreparedFilterDraft) => saved(filter));
    owner.activateSession("session-1");
    owner.handle(request(), save);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ color: "#aabbcc", opacity: 48 }),
      false,
    );
  });
});

describe("FilterPreviewOwner", () => {
  it("accepts only increasing revisions from the active session", () => {
    const owner = new FilterPreviewOwner();
    expect(owner.activateSession("session-1")).toBeNull();
    expect(
      owner.receive({ type: "update", sessionId: "session-1", revision: 2, draft, only: true }),
    ).toMatchObject({ only: true, draft: { query: draft.query } });
    expect(
      owner.receive({ type: "update", sessionId: "session-1", revision: 1, draft, only: false }),
    ).toBeUndefined();
    expect(
      owner.receive({ type: "update", sessionId: "stale", revision: 3, draft, only: false }),
    ).toBeUndefined();
  });

  it("cannot resurrect a preview after clear, replacement, or crash deactivation", () => {
    const owner = new FilterPreviewOwner();
    owner.activateSession("session-1");
    owner.receive({ type: "update", sessionId: "session-1", revision: 1, draft, only: false });
    expect(owner.receive({ type: "clear", sessionId: "session-1", revision: 2 })).toBeNull();
    expect(
      owner.receive({ type: "update", sessionId: "session-1", revision: 1, draft, only: true }),
    ).toBeUndefined();
    expect(owner.activateSession("session-2")).toBeNull();
    expect(
      owner.receive({ type: "update", sessionId: "session-1", revision: 99, draft, only: true }),
    ).toBeUndefined();
    expect(owner.deactivateSession("session-2")).toBeNull();
    expect(
      owner.receive({ type: "update", sessionId: "session-2", revision: 100, draft, only: true }),
    ).toBeUndefined();
  });
});

describe("FilterWindowSession", () => {
  it("installs state and result listeners before announcing readiness", async () => {
    const harness = transportHarness();
    const session = new FilterWindowSession({
      sessionId: "session-1",
      transport: harness.transport,
      onState: vi.fn(),
      onError: vi.fn(),
    });
    await session.start();
    expect(harness.order).toEqual(["state-listener", "result-listener", "ready"]);
    session.dispose();
  });

  it("retries a ready registration rejected before the native binding exists", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness();
      const requestState = vi
        .fn<FilterWindowSessionTransport["requestState"]>()
        .mockRejectedValueOnce(new Error("not bound yet"))
        .mockResolvedValue(undefined);
      harness.transport.requestState = requestState;
      const onState = vi.fn();
      const onError = vi.fn();
      const session = new FilterWindowSession({
        sessionId: "session-1",
        transport: harness.transport,
        onState,
        onError,
        retryMs: 10,
      });

      await session.start();
      expect(requestState).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("not bound yet"));
      await vi.advanceTimersByTimeAsync(10);
      expect(requestState).toHaveBeenCalledTimes(2);

      harness.state({
        sessionId: "session-1",
        existingFilters: [],
        filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
        initialDraft: draft,
      });
      expect(onState).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      expect(requestState).toHaveBeenCalledTimes(2);
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending save and ignores late events after disposal", async () => {
    const harness = transportHarness();
    const onState = vi.fn();
    const session = new FilterWindowSession({
      sessionId: "session-1",
      transport: harness.transport,
      onState,
      onError: vi.fn(),
      requestId: () => "request-1",
    });
    await session.start();
    const pending = session.save(draft, true);
    expect(harness.transport.requestSave).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ opacity: 47.6 }), only: true }),
    );
    session.dispose();
    harness.state({
      sessionId: "session-1",
      existingFilters: [],
      filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
      initialDraft: draft,
    });
    harness.result({ sessionId: "session-1", requestId: "request-1", ok: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "The filter window was closed before the save completed.",
    });
    expect(onState).not.toHaveBeenCalled();
  });

  it("cleans a partial listener installation when startup fails", async () => {
    const stopState = vi.fn(() => {});
    const onError = vi.fn();
    const transport: FilterWindowSessionTransport = {
      onState: () => Promise.resolve(stopState),
      onSaveResult: () => Promise.reject(new Error("listen failed")),
      requestState: vi.fn(() => Promise.resolve()),
      requestSave: vi.fn(() => Promise.resolve()),
    };
    const session = new FilterWindowSession({
      sessionId: "session-1",
      transport,
      onState: vi.fn(),
      onError,
    });
    await session.start();
    await flush();
    expect(stopState).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("listen failed"));
  });
});
