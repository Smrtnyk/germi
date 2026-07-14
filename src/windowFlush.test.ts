import { beforeEach, describe, expect, it, vi } from "vitest";

import { flushDetachedWindows, onWindowFlushRequested } from "./windowFlush";

const eventBus = vi.hoisted(() => {
  type Handler = (event: { payload: unknown }) => void;
  const listeners = new Map<string, Set<Handler>>();
  const listen = vi.fn((event: string, handler: Handler) => {
    const handlers = listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return Promise.resolve(() => handlers.delete(handler));
  });
  const emit = vi.fn((event: string, payload: unknown) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler({ payload });
    return Promise.resolve();
  });
  return { emit, listen, listeners };
});

vi.mock("@tauri-apps/api/event", () => ({ emit: eventBus.emit, listen: eventBus.listen }));

const noop = () => {};

beforeEach(() => {
  eventBus.listeners.clear();
  eventBus.emit.mockClear();
  eventBus.listen.mockClear();
});

describe("detached window flush handshake", () => {
  it("waits for every target and forwards the close-after-flush request", async () => {
    const flushA = vi.fn(() => Promise.resolve());
    const flushB = vi.fn(() => Promise.resolve());
    const unlistenA = await onWindowFlushRequested({
      requestEvent: "flush-request",
      resultEvent: "flush-result",
      targetId: "a",
      flush: flushA,
    });
    const unlistenB = await onWindowFlushRequested({
      requestEvent: "flush-request",
      resultEvent: "flush-result",
      targetId: "b",
      flush: flushB,
    });

    await flushDetachedWindows({
      requestEvent: "flush-request",
      resultEvent: "flush-result",
      closeAfterFlush: true,
      timeoutMs: 100,
      listOpenTargetIds: () => Promise.resolve(["a", "b"]),
      onTargetClosed: () => Promise.resolve(noop),
      saveError: (id) => `${id} could not save`,
      timeoutError: () => "timed out",
    });

    expect(flushA).toHaveBeenCalledExactlyOnceWith(true);
    expect(flushB).toHaveBeenCalledExactlyOnceWith(true);
    unlistenA();
    unlistenB();
  });

  it("surfaces a target's save failure", async () => {
    const unlisten = await onWindowFlushRequested({
      requestEvent: "flush-request",
      resultEvent: "flush-result",
      targetId: "scripts",
      flush: () => Promise.reject(new Error("disk full")),
    });

    await expect(
      flushDetachedWindows({
        requestEvent: "flush-request",
        resultEvent: "flush-result",
        closeAfterFlush: false,
        timeoutMs: 100,
        listOpenTargetIds: () => Promise.resolve(["scripts"]),
        onTargetClosed: () => Promise.resolve(noop),
        saveError: () => "scripts could not save",
        timeoutError: () => "timed out",
      }),
    ).rejects.toThrow("disk full");
    unlisten();
  });

  it("does not re-add a target whose close races listener setup", async () => {
    const listOpenTargetIds = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["rule-1"])
      // Model a shell snapshot that still contains the just-closed window.
      .mockResolvedValueOnce(["rule-1"]);

    await flushDetachedWindows({
      requestEvent: "flush-request",
      resultEvent: "flush-result",
      closeAfterFlush: false,
      timeoutMs: 100,
      listOpenTargetIds,
      onTargetClosed: (handler) => {
        handler("rule-1");
        return Promise.resolve(noop);
      },
      saveError: () => "rule could not save",
      timeoutError: () => "timed out",
    });

    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
