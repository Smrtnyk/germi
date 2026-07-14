import { describe, expect, it } from "vitest";

import { OrderedTaskQueue } from "./orderedTaskQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("OrderedTaskQueue", () => {
  it("does not start a later operation until the earlier one settles", async () => {
    const queue = new OrderedTaskQueue();
    const first = deferred<void>();
    const order: string[] = [];

    const firstResult = queue.run(async () => {
      order.push("first started");
      await first.promise;
      order.push("first finished");
    });
    const secondResult = queue.run(() => {
      order.push("second started");
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual(["first started"]);
    first.resolve();
    await Promise.all([firstResult, secondResult]);
    expect(order).toEqual(["first started", "first finished", "second started"]);
  });

  it("continues after a failed operation without hiding that failure", async () => {
    const queue = new OrderedTaskQueue();
    const failed = queue.run(() => Promise.reject(new Error("write failed")));
    const next = queue.run(() => Promise.resolve("saved"));

    await expect(failed).rejects.toThrow("write failed");
    await expect(next).resolves.toBe("saved");
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it("flush follows work appended while the previous tail is settling", async () => {
    const queue = new OrderedTaskQueue();
    const first = deferred<void>();
    const second = deferred<void>();
    const secondStarted = deferred<void>();

    void queue.run(() => first.promise);
    const draining = queue.flush();
    first.promise.then(() => {
      void queue.run(() => {
        secondStarted.resolve();
        return second.promise;
      });
    });
    first.resolve();
    await secondStarted.promise;

    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    second.resolve();
    await draining;
  });
});
