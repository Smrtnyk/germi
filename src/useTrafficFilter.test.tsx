import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { summary } from "./flowFixtures";
import { api, type FlowFilterBatchResult, type FlowFilterRequest } from "./ipc";
import { useFilterMatches, type TrafficFilterSpec } from "./useTrafficFilter";
import type { FlowSummary } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function result(filters: FlowFilterRequest[], matched: (request: FlowFilterRequest) => string[]) {
  return {
    cancelled: false,
    filters: filters.map((request) => ({ key: request.key, matched: matched(request) })),
  } satisfies FlowFilterBatchResult;
}

function MatchHarness({ flows, specs }: { flows: FlowSummary[]; specs: TrafficFilterSpec[] }) {
  const matches = useFilterMatches(flows, specs, vi.fn());
  const snapshot = Object.fromEntries(
    [...matches.byId].map(([id, match]) => [
      id,
      {
        matched: match.matchedIds ? [...match.matchedIds].sort() : null,
        confirmed: match.confirmedIds ? [...match.confirmedIds].sort() : null,
        searching: match.searching,
        failed: match.failed,
      },
    ]),
  );
  return <output aria-label="match snapshot">{JSON.stringify(snapshot)}</output>;
}

function readSnapshot(screen: Awaited<ReturnType<typeof render>>) {
  return JSON.parse(screen.getByLabelText("match snapshot").element().textContent ?? "{}");
}

afterEach(() => vi.restoreAllMocks());

describe("useFilterMatches", () => {
  it("batches bar, saved, solo-compatible, and draft plans together", async () => {
    vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    const search = vi.spyOn(api, "searchFlowFilters").mockImplementation((filters) =>
      Promise.resolve(
        result(filters, (request) => {
          const value = request.terms[0]?.value;
          return value === "alpha" ? ["1"] : value === "beta" ? ["2"] : ["3"];
        }),
      ),
    );
    const flows = ["1", "2", "3"].map((id) => summary({ id }));
    const specs = [
      { id: "bar", query: "alpha", kinds: [], statuses: [] },
      { id: "saved:one", query: "beta", kinds: [], statuses: [] },
      { id: "draft", query: "gamma", kinds: [], statuses: [] },
    ];
    const screen = await render(<MatchHarness flows={flows} specs={specs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    await vi.waitFor(() => {
      const snapshot = readSnapshot(screen);
      expect(snapshot.bar.confirmed).toEqual(["1"]);
      expect(snapshot["saved:one"].confirmed).toEqual(["2"]);
      expect(snapshot.draft.confirmed).toEqual(["3"]);
    });
    expect(search.mock.calls[0][0]).toHaveLength(3);
  });

  it("keeps changed flow objects fail-open and rejects an older same-config verdict", async () => {
    vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    const first = deferred<FlowFilterBatchResult>();
    const second = deferred<FlowFilterBatchResult>();
    const third = deferred<FlowFilterBatchResult>();
    const search = vi
      .spyOn(api, "searchFlowFilters")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const pending = summary({ id: "flow", status: null, respSize: 0 });
    const specs = [{ id: "bar", query: "needle", kinds: [], statuses: [] }];
    const screen = await render(<MatchHarness flows={[pending]} specs={specs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(readSnapshot(screen).bar).toMatchObject({ matched: ["flow"], confirmed: [] });

    const completed = { ...pending, status: 200, respSize: 20 };
    await screen.rerender(<MatchHarness flows={[completed]} specs={specs} />);
    first.resolve(result(search.mock.calls[0][0], () => []));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(readSnapshot(screen).bar).toMatchObject({ matched: ["flow"], confirmed: [] });
    second.resolve(result(search.mock.calls[1][0], () => ["flow"]));
    await vi.waitFor(() =>
      expect(readSnapshot(screen).bar).toMatchObject({ matched: ["flow"], confirmed: ["flow"] }),
    );

    await screen.rerender(<MatchHarness flows={[]} specs={specs} />);
    await vi.waitFor(() =>
      expect(readSnapshot(screen).bar).toMatchObject({ matched: [], confirmed: [] }),
    );

    await screen.rerender(<MatchHarness flows={[completed]} specs={specs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(readSnapshot(screen).bar).toMatchObject({ matched: ["flow"], confirmed: [] });
    third.resolve(result(search.mock.calls[2][0], () => []));
    await vi.waitFor(() =>
      expect(readSnapshot(screen).bar).toMatchObject({ matched: [], confirmed: [] }),
    );
  });

  it("rescans an identical-looking replacement object from a resync", async () => {
    vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    const search = vi
      .spyOn(api, "searchFlowFilters")
      .mockImplementation((filters) =>
        Promise.resolve(result(filters, (request) => request.candidates)),
      );
    const flow = summary({ id: "flow", status: 200, respSize: 20 });
    const specs = [{ id: "bar", query: "needle", kinds: [], statuses: [] }];
    const screen = await render(<MatchHarness flows={[flow]} specs={specs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(readSnapshot(screen).bar.confirmed).toEqual(["flow"]));
    await screen.rerender(<MatchHarness flows={[{ ...flow }]} specs={specs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readSnapshot(screen).bar.confirmed).toEqual(["flow"]));
  });

  it("cancels a changed query and cannot merge its late result", async () => {
    const cancel = vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    const oldSearch = deferred<FlowFilterBatchResult>();
    const newSearch = deferred<FlowFilterBatchResult>();
    const search = vi
      .spyOn(api, "searchFlowFilters")
      .mockImplementationOnce(() => oldSearch.promise)
      .mockImplementationOnce(() => newSearch.promise);
    const flows = [summary({ id: "old" }), summary({ id: "new" })];
    const oldSpecs = [{ id: "bar", query: "old-term", kinds: [], statuses: [] }];
    const screen = await render(<MatchHarness flows={flows} specs={oldSpecs} />);
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    const newSpecs = [{ id: "bar", query: "new-term", kinds: [], statuses: [] }];
    await screen.rerender(<MatchHarness flows={flows} specs={newSpecs} />);
    await vi.waitFor(() => expect(cancel.mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    newSearch.resolve(result(search.mock.calls[1][0], () => ["new"]));
    await vi.waitFor(() => expect(readSnapshot(screen).bar.confirmed).toEqual(["new"]));
    oldSearch.resolve(result(search.mock.calls[0][0], () => ["old"]));
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(readSnapshot(screen).bar.confirmed).toEqual(["new"]);
  });

  it("keeps candidates visible when the backend snapshot fails", async () => {
    vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    vi.spyOn(api, "searchFlowFilters").mockRejectedValue(
      new Error("flow store lock poisoned while taking filter snapshot"),
    );
    const flows = [summary({ id: "one" }), summary({ id: "two" })];
    const specs = [{ id: "bar", query: "needle", kinds: [], statuses: [] }];
    const screen = await render(<MatchHarness flows={flows} specs={specs} />);

    await vi.waitFor(() =>
      expect(readSnapshot(screen).bar).toMatchObject({
        matched: ["one", "two"],
        confirmed: [],
        searching: false,
        failed: true,
      }),
    );
  });

  it("converges for multiple plans larger than one batch", async () => {
    vi.spyOn(api, "cancelFlowFilterSearch").mockResolvedValue();
    const search = vi
      .spyOn(api, "searchFlowFilters")
      .mockImplementation((filters) =>
        Promise.resolve(result(filters, (request) => request.candidates)),
      );
    const flows = Array.from({ length: 700 }, (_, index) => summary({ id: `flow-${index}` }));
    const specs = [
      { id: "saved:a", query: "alpha", kinds: [], statuses: [] },
      { id: "draft", query: "beta", kinds: [], statuses: [] },
    ];
    const screen = await render(<MatchHarness flows={flows} specs={specs} />);
    await vi.waitFor(() => {
      const snapshot = readSnapshot(screen);
      expect(snapshot["saved:a"].confirmed).toHaveLength(700);
      expect(snapshot.draft.confirmed).toHaveLength(700);
    });
    expect(search.mock.calls.length).toBeGreaterThan(2);
    for (const [requests] of search.mock.calls) {
      const size = requests.reduce((count, request) => count + request.candidates.length, 0);
      expect(size).toBeLessThanOrEqual(512);
    }
    expect(search.mock.calls[0][0]).toHaveLength(2);
  });
});
