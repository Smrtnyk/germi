import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFilter } from "./filter";
import { api } from "./ipc";
import { applyScanVerdicts, mergeScan, runContentSearch, type ScanState } from "./useTrafficFilter";

afterEach(() => vi.restoreAllMocks());

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

describe("runContentSearch", () => {
  it("ANDs request and response cookie terms on the same flow", async () => {
    const search = vi
      .spyOn(api, "searchCookies")
      .mockImplementation((pattern) =>
        Promise.resolve(
          pattern === "request-id=req-7" ? ["both", "request-only"] : ["both", "response-only"],
        ),
      );
    const terms = parseFilter(
      "req-cookie:request-id=req-7 resp-cookie:response-id=resp-9",
    ).contentTerms;

    await expect(
      runContentSearch(terms, ["both", "request-only", "response-only"], () => false),
    ).resolves.toEqual(["both"]);
    expect(search).toHaveBeenNthCalledWith(1, "request-id=req-7", "request", false, [
      "both",
      "request-only",
      "response-only",
    ]);
    expect(search).toHaveBeenNthCalledWith(2, "response-id=resp-9", "response", false, [
      "both",
      "request-only",
    ]);
  });

  it("subtracts matches for a negated cookie term", async () => {
    vi.spyOn(api, "searchCookies").mockResolvedValue(["debug", "both"]);
    const terms = parseFilter("-cookie:debug=true").contentTerms;

    await expect(runContentSearch(terms, ["clean", "debug", "both"], () => false)).resolves.toEqual(
      ["clean"],
    );
  });
});
