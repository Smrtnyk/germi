/**
 * Runs state mutations in invocation order. Tauri commands execute on an async
 * runtime, so creating their promises in click order does not guarantee that
 * backend transactions acquire their locks in that order.
 */
export class OrderedTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async flush(): Promise<void> {
    // A completion callback can enqueue another operation while the current
    // tail is resolving. Follow the moving tail until the queue is truly idle.
    for (;;) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail) return;
    }
  }
}
