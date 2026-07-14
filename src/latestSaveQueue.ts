/** A debounced, serialized "latest snapshot wins" writer. Immediate saves cancel
 * stale timers; values arriving during an in-flight write are coalesced and run
 * only after that write finishes. */
export class LatestSaveQueue<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: T | undefined;
  private hasPending = false;
  private ready = false;
  private running = false;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private cycleError: unknown;
  private hasCycleError = false;
  private cancellationGeneration = 0;

  constructor(
    private readonly save: (value: T) => Promise<unknown>,
    private readonly delayMs: number,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    this.hasPending = true;
    this.clearTimer();
    // Once a caller is awaiting a drain (window close, pop-out, or an immediate
    // toggle), a newer edit that arrives during the active write belongs to that
    // same drain. Saving it immediately after the active write prevents the
    // waiter from resolving against an already-stale snapshot.
    if (this.waiters.length > 0) {
      this.ready = true;
      this.kick();
      return;
    }
    this.ready = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ready = true;
      this.kick();
    }, this.delayMs);
  }

  saveNow(value: T): Promise<void> {
    this.clearTimer();
    this.pending = value;
    this.hasPending = true;
    this.ready = true;
    return this.waitForDrain();
  }

  flush(): Promise<void> {
    this.clearTimer();
    if (this.hasPending) this.ready = true;
    if (!this.running && !this.ready) return Promise.resolve();
    return this.waitForDrain();
  }

  cancelPending(): void {
    this.clearTimer();
    this.pending = undefined;
    this.hasPending = false;
    this.ready = false;
    // A currently-running save cannot be aborted, but if it fails afterward it
    // must not resurrect the snapshot this cancellation deliberately discarded.
    this.cancellationGeneration += 1;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private waitForDrain(): Promise<void> {
    if (!this.running && this.waiters.length === 0) {
      this.cycleError = undefined;
      this.hasCycleError = false;
    }
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    this.kick();
    return done;
  }

  private kick(): void {
    if (this.running || !this.ready || !this.hasPending) return;
    const value = this.pending as T;
    const generation = this.cancellationGeneration;
    this.pending = undefined;
    this.hasPending = false;
    this.ready = false;
    this.running = true;
    void Promise.resolve()
      .then(() => this.save(value))
      .then(() => {
        // A newer snapshot that succeeds makes an earlier failed attempt in the
        // same drain cycle irrelevant: the queue promises latest-state durability.
        this.cycleError = undefined;
        this.hasCycleError = false;
      })
      .catch((error: unknown) => {
        if (!this.hasCycleError) this.cycleError = error;
        this.hasCycleError = true;
        // Do not forget the only copy of a failed background snapshot. Leave it
        // pending (but not hot-looping) so flush/saveNow can retry it. A newer
        // pending value already supersedes this one and must win.
        if (!this.hasPending && generation === this.cancellationGeneration) {
          this.pending = value;
          this.hasPending = true;
          this.ready = false;
        }
      })
      .finally(() => {
        this.running = false;
        if (this.ready && this.hasPending) this.kick();
        else this.settle();
      });
  }

  private settle(): void {
    const waiters = this.waiters.splice(0);
    const error = this.cycleError;
    const failed = this.hasCycleError;
    this.cycleError = undefined;
    this.hasCycleError = false;
    for (const waiter of waiters) {
      if (!failed) waiter.resolve();
      else waiter.reject(error);
    }
  }
}
