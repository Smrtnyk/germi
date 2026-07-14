/**
 * Tracks mounted editor flushes and keeps an unmounted editor registered until
 * its final write succeeds. This closes the hand-off gap where one editor is
 * replaced by another (for example, switching scenarios) immediately before
 * the application shutdown barrier runs.
 */
export class EditorFlushRegistry {
  private readonly entries = new Set<FlushEntry>();
  private topologyVersion = 0;

  register(flush: () => Promise<void>): () => void {
    const entry: FlushEntry = { flush, mounted: true, inFlight: null };
    this.entries.add(entry);
    this.topologyVersion += 1;

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      entry.mounted = false;
      this.topologyVersion += 1;
      // Start the final save promptly. A failure deliberately leaves the entry
      // in the registry so an explicit app-close flush can retry it.
      void this.run(entry).catch(() => {});
    };
  }

  async flushAll(): Promise<void> {
    // A scenario can be replaced while an earlier flush is awaiting IPC. Loop
    // when registration topology changed so both sides of that hand-off are
    // included in the same shutdown barrier.
    for (;;) {
      const version = this.topologyVersion;
      await Promise.all([...this.entries].map((entry) => this.run(entry)));
      if (version === this.topologyVersion) return;
    }
  }

  private run(entry: FlushEntry): Promise<void> {
    if (entry.inFlight) return entry.inFlight;

    const pending = Promise.resolve()
      .then(entry.flush)
      .then(() => {
        if (!entry.mounted) this.entries.delete(entry);
      })
      .finally(() => {
        if (entry.inFlight === pending) entry.inFlight = null;
      });
    entry.inFlight = pending;
    return pending;
  }
}

interface FlushEntry {
  flush: () => Promise<void>;
  mounted: boolean;
  inFlight: Promise<void> | null;
}
