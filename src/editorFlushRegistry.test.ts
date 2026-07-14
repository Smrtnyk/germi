import { describe, expect, it, vi } from "vitest";

import { EditorFlushRegistry } from "./editorFlushRegistry";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EditorFlushRegistry", () => {
  it("flushes every mounted editor", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const registry = new EditorFlushRegistry();
    registry.register(first);
    registry.register(second);

    await registry.flushAll();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("shares an unmount flush with an overlapping shutdown barrier", async () => {
    const write = deferred();
    const flush = vi.fn(() => write.promise);
    const registry = new EditorFlushRegistry();
    const unregister = registry.register(flush);

    unregister();
    const shutdown = registry.flushAll();
    await Promise.resolve();

    expect(flush).toHaveBeenCalledOnce();
    write.resolve();
    await shutdown;
  });

  it("retains a failed retired editor so shutdown can retry it", async () => {
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const registry = new EditorFlushRegistry();
    const unregister = registry.register(flush);

    unregister();
    // Let the fire-and-forget retirement attempt reject and release its shared
    // in-flight promise before simulating a later close attempt.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await registry.flushAll();

    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("includes a replacement editor registered during an active flush", async () => {
    const oldWrite = deferred();
    const oldFlush = vi.fn(() => oldWrite.promise);
    const newFlush = vi.fn(async () => {});
    const registry = new EditorFlushRegistry();
    const unregisterOld = registry.register(oldFlush);

    const shutdown = registry.flushAll();
    await Promise.resolve();
    unregisterOld();
    registry.register(newFlush);
    oldWrite.resolve();
    await shutdown;

    expect(oldFlush).toHaveBeenCalledOnce();
    expect(newFlush).toHaveBeenCalledOnce();
  });
});
