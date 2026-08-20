import { describe, expect, it, vi } from "vitest";

import {
  drainPendingFlowEventsForGeneration,
  loadStableFlowSnapshotForSubscription,
  type PendingFlowBatch,
} from "./appState";
import type { FlowSummary } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summary(id: string): FlowSummary {
  return {
    id,
    seq: 1,
    method: "GET",
    host: "example.test",
    path: `/${id}`,
    scheme: "https",
    status: 200,
    mime: "text/plain",
    kind: "doc",
    reqSize: 0,
    respSize: 0,
    durationMs: 1,
    ttfbMs: 1,
    matchedRule: null,
    timestampMs: 1,
    comment: null,
    availability: null,
    imported: false,
    extra: {},
  };
}

describe("flow snapshot reconciliation", () => {
  it("discards a yielded build when its subscription is replaced", async () => {
    const firstReady = Promise.resolve();
    const secondReady = Promise.resolve();
    let ready = firstReady;
    const staleBuild = deferred<{ map: Map<string, FlowSummary>; order: string[] }>();
    const stale = summary("stale");
    const fresh = summary("fresh");
    const listFlows = vi
      .fn<() => Promise<FlowSummary[]>>()
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([fresh]);
    const build = vi
      .fn<(flows: FlowSummary[]) => Promise<{ map: Map<string, FlowSummary>; order: string[] }>>()
      .mockImplementationOnce(() => staleBuild.promise)
      .mockImplementationOnce((flows) =>
        Promise.resolve({
          map: new Map(flows.map((flow) => [flow.id, flow])),
          order: flows.map((flow) => flow.id),
        }),
      );
    const installed: string[][] = [];
    const drainPending = vi.fn(() => false);

    const loading = loadStableFlowSnapshotForSubscription(
      () => ready,
      listFlows,
      ({ order }) => installed.push(order),
      drainPending,
      build,
    );
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());

    // StrictMode/hot reload installs a new channel while the old snapshot
    // builder is cooperatively yielded. Resolving the stale build must retry,
    // not expose it or drain events from the new channel against it.
    ready = secondReady;
    staleBuild.resolve({ map: new Map([[stale.id, stale]]), order: [stale.id] });
    await loading;

    expect(listFlows).toHaveBeenCalledTimes(2);
    expect(installed).toEqual([[fresh.id]]);
    expect(drainPending).toHaveBeenCalledOnce();
  });

  it("does not replay an old subscription update over the replacement snapshot", async () => {
    const firstReady = Promise.resolve();
    const secondReady = Promise.resolve();
    let ready = firstReady;
    let generation = 1;
    const staleBuild = deferred<{ map: Map<string, FlowSummary>; order: string[] }>();
    const resurrected = summary("removed-by-new-snapshot");
    const pending: PendingFlowBatch[] = [
      { generation: 1, events: [{ type: "completed", summary: resurrected }] },
    ];
    const listFlows = vi
      .fn<() => Promise<FlowSummary[]>>()
      .mockResolvedValueOnce([resurrected])
      .mockResolvedValueOnce([]);
    const build = vi
      .fn<(flows: FlowSummary[]) => Promise<{ map: Map<string, FlowSummary>; order: string[] }>>()
      .mockImplementationOnce(() => staleBuild.promise)
      .mockImplementationOnce(() => Promise.resolve({ map: new Map(), order: [] }));
    let installed = { map: new Map<string, FlowSummary>(), order: [] as string[] };

    const loading = loadStableFlowSnapshotForSubscription(
      () => ready,
      listFlows,
      (snapshot) => {
        installed = snapshot;
      },
      () =>
        drainPendingFlowEventsForGeneration(pending, generation, installed.map, installed.order),
      build,
    );
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());

    // The old callback queued Completed before StrictMode replaced its channel.
    // The new authoritative snapshot removes that row while the old build is
    // yielded; its batch must not resurrect the row after the retry.
    generation = 2;
    ready = secondReady;
    staleBuild.resolve({
      map: new Map([[resurrected.id, resurrected]]),
      order: [resurrected.id],
    });
    await loading;

    expect(listFlows).toHaveBeenCalledTimes(2);
    expect([...installed.map.keys()]).toEqual([]);
    expect(installed.order).toEqual([]);
    expect(pending).toEqual([]);
  });
});
