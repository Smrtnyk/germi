import { afterEach, describe, expect, it, vi } from "vitest";

import { LatestSaveQueue } from "./latestSaveQueue";

afterEach(() => vi.useRealTimers());

describe("LatestSaveQueue", () => {
  it("cancels a stale debounce when an immediate snapshot is saved", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const queue = new LatestSaveQueue(save, 400);
    queue.schedule("old edit");
    await queue.saveNow("new toggle");
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("new toggle");
  });

  it("debounces to the latest scheduled snapshot", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const queue = new LatestSaveQueue(save, 400);
    queue.schedule("a");
    queue.schedule("ab");
    queue.schedule("abc");
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("abc");
  });

  it("serializes a newer save behind an in-flight write", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const queue = new LatestSaveQueue(async (value: string) => {
      calls.push(value);
      if (value === "first") await firstBlocked;
    }, 400);

    const first = queue.saveNow("first");
    await Promise.resolve();
    const second = queue.saveNow("second");
    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("includes an edit scheduled during an awaited write in the same drain", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const queue = new LatestSaveQueue(async (value: string) => {
      calls.push(value);
      if (value === "first") await firstBlocked;
    }, 400);

    let drained = false;
    const drain = queue.saveNow("first").then(() => {
      drained = true;
    });
    await Promise.resolve();
    queue.schedule("new edit while closing");
    releaseFirst();
    await drain;

    expect(calls).toEqual(["first", "new edit while closing"]);
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2);
  });

  it("flushes a pending debounce and cancelPending discards one", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const queue = new LatestSaveQueue(save, 400);
    queue.schedule("flush me");
    await queue.flush();
    expect(save).toHaveBeenCalledWith("flush me");
    queue.schedule("discard me");
    queue.cancelPending();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("rejects immediate callers when persistence fails", async () => {
    const queue = new LatestSaveQueue(() => Promise.reject(new Error("disk full")), 400);
    await expect(queue.saveNow("value")).rejects.toThrow("disk full");
  });

  it("retains a failed background snapshot so flush can retry it", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const queue = new LatestSaveQueue(save, 400);

    queue.schedule("unsaved edit");
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, "unsaved edit");
    expect(save).toHaveBeenNthCalledWith(2, "unsaved edit");
  });

  it("rejects flush when retrying a failed background snapshot still fails", async () => {
    vi.useFakeTimers();
    const queue = new LatestSaveQueue(() => Promise.reject(new Error("still read-only")), 400);

    queue.schedule("unsaved edit");
    await vi.advanceTimersByTimeAsync(400);
    await expect(queue.flush()).rejects.toThrow("still read-only");
  });

  it("does not resurrect an in-flight snapshot cancelled by an external reload", async () => {
    let rejectSave!: (error: unknown) => void;
    const save = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const queue = new LatestSaveQueue(save, 400);

    const active = queue.saveNow("stale local copy");
    await Promise.resolve();
    queue.cancelPending();
    const rejected = expect(active).rejects.toThrow("disk full");
    rejectSave(new Error("disk full"));
    await rejected;

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
  });

  it("lets a reload wait for an in-flight write after cancelling queued edits", async () => {
    let releaseSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const queue = new LatestSaveQueue(() => saveBlocked, 400);

    const active = queue.saveNow("write already in progress");
    await Promise.resolve();
    queue.schedule("queued edit to discard");
    queue.cancelPending();

    let reloadMayRead = false;
    const waitForActiveWrite = queue.flush().then(() => {
      reloadMayRead = true;
    });
    await Promise.resolve();
    expect(reloadMayRead).toBe(false);

    releaseSave();
    await Promise.all([active, waitForActiveWrite]);
    expect(reloadMayRead).toBe(true);
  });
});
