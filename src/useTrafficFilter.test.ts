import { describe, expect, it } from "vitest";

import { parseFilter } from "./filter";
import {
  applyScanVerdicts,
  buildFilterSearchBatch,
  emptyScan,
  mergeScan,
  type ScanState,
} from "./useTrafficFilter";

function scan(scanned: string[], matched: string[], failed: string[] = []): ScanState {
  return {
    scanned: new Set(scanned),
    matched: new Set(matched),
    failed: new Set(failed),
    versions: new Map(scanned.map((id) => [id, 0])),
  };
}

describe("mergeScan", () => {
  it("keeps a reset state inert and accumulates successful and failed verdicts", () => {
    expect(mergeScan(null, ["1"], ["1"])).toBeNull();
    const merged = mergeScan(scan(["1", "2"], ["1"]), ["3", "4"], ["4"], ["3"]);
    expect([...(merged?.scanned ?? [])].sort()).toEqual(["1", "2", "3", "4"]);
    expect([...(merged?.matched ?? [])].sort()).toEqual(["1", "4"]);
    expect([...(merged?.failed ?? [])]).toEqual(["3"]);
  });
});

describe("applyScanVerdicts", () => {
  it("drops confirmed misses while keeping unscanned and failed candidates visible", () => {
    const out = applyScanVerdicts(
      new Set(["1", "2", "3", "9"]),
      scan(["1", "2", "3"], ["2"], ["3"]),
    );
    expect([...out].sort()).toEqual(["2", "3", "9"]);
  });
});

describe("buildFilterSearchBatch", () => {
  it("shares a bounded chunk fairly across active plans", () => {
    const ids = Array.from({ length: 700 }, (_, index) => `flow-${index}`);
    const terms = parseFilter("needle").contentTerms;
    const plans = ["saved", "draft"].map((key) => ({
      key,
      candidateIds: ids,
      candidateVersions: new Map(ids.map((id) => [id, 1])),
      terms,
    }));
    const batch = buildFilterSearchBatch(plans, new Map(), 512);
    expect(batch).toHaveLength(2);
    expect(batch.map((request) => request.candidates.length)).toEqual([256, 256]);
    expect(batch.reduce((total, request) => total + request.candidates.length, 0)).toBe(512);
  });

  it("rescans a changed flow version but not an unchanged verdict", () => {
    const terms = parseFilter("needle").contentTerms;
    const state = emptyScan();
    state.scanned.add("same");
    state.scanned.add("changed");
    state.versions.set("same", 4);
    state.versions.set("changed", 4);
    const batch = buildFilterSearchBatch(
      [
        {
          key: "bar",
          candidateIds: ["same", "changed"],
          candidateVersions: new Map([
            ["same", 4],
            ["changed", 5],
          ]),
          terms,
        },
      ],
      new Map([["bar", state]]),
    );
    expect(batch[0].candidates).toEqual(["changed"]);
  });

  it("rotates capacity to every plan when there are more plans than batch slots", () => {
    const terms = parseFilter("needle").contentTerms;
    const ids = ["first", "second"];
    const plans = Array.from({ length: 600 }, (_, index) => ({
      key: `plan-${index}`,
      candidateIds: ids,
      candidateVersions: new Map(ids.map((id) => [id, 1])),
      terms,
    }));
    const first = buildFilterSearchBatch(plans, new Map(), 512);
    const scans = new Map<string, ScanState>();
    for (const request of first) {
      const state = emptyScan();
      for (const id of request.candidates) state.versions.set(id, 1);
      scans.set(request.key, state);
    }

    const second = buildFilterSearchBatch(plans, scans, 512);
    expect(second.slice(0, 88).map((request) => request.key)).toEqual(
      Array.from({ length: 88 }, (_, index) => `plan-${index + 512}`),
    );
  });
});
