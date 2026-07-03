import { describe, expect, it } from "vitest";

import { applyScanVerdicts, mergeScan, type ScanState } from "./useTrafficFilter";

function scan(scanned: string[], matched: string[]): ScanState {
  return { scanned: new Set(scanned), matched: new Set(matched) };
}

describe("mergeScan", () => {
  it("keeps a reset (null) state so a stale chunk can't resurrect old verdicts", () => {
    expect(mergeScan(null, ["1"], ["1"])).toBeNull();
  });

  it("accumulates scanned ids and matches across chunks", () => {
    const merged = mergeScan(scan(["1", "2"], ["1"]), ["3", "4"], ["4"]);
    expect([...(merged?.scanned ?? [])].sort()).toEqual(["1", "2", "3", "4"]);
    expect([...(merged?.matched ?? [])].sort()).toEqual(["1", "4"]);
  });
});

describe("applyScanVerdicts", () => {
  it("keeps scanned matches and drops scanned non-matches", () => {
    const out = applyScanVerdicts(new Set(["1", "2"]), scan(["1", "2"], ["2"]));
    expect([...out]).toEqual(["2"]);
  });

  it("treats flows the scan has not reached yet as matching", () => {
    const out = applyScanVerdicts(new Set(["1", "2", "9"]), scan(["1", "2"], ["2"]));
    expect([...out].sort()).toEqual(["2", "9"]);
  });
});
