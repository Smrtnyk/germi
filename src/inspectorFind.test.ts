import { describe, expect, it } from "vitest";
import {
  bodyOccurrences,
  combineMatches,
  countOccurrences,
  fold,
  headerMatches,
} from "./inspectorFind";

const URL = "https://api.example.com/aaa?x=aa";
const HEADERS: [string, string][] = [
  ["content-type", "application/json"],
  ["x-aa", "1"],
  ["x-trace", "zzz"],
];

describe("fold", () => {
  it("lowercases when case-insensitive and preserves case when sensitive", () => {
    expect(fold("AaBb", false)).toBe("aabb");
    expect(fold("AaBb", true)).toBe("AaBb");
  });
});

describe("countOccurrences", () => {
  it("counts every non-overlapping occurrence, case-insensitively", () => {
    expect(countOccurrences("AaAa", "a")).toBe(4);
    expect(countOccurrences("banana", "ana")).toBe(1);
    expect(countOccurrences("XX-xx-XX", "xx")).toBe(3);
  });
  it("counts only exact-case occurrences when case-sensitive", () => {
    expect(countOccurrences("AaAa", "a", true)).toBe(2);
    expect(countOccurrences("XX-xx-XX", "xx", true)).toBe(1);
    expect(countOccurrences("Token token TOKEN", "token", true)).toBe(1);
  });
  it("returns 0 for empty query", () => {
    expect(countOccurrences("anything", "")).toBe(0);
  });
  it("returns 0 when the query is longer than the haystack", () => {
    expect(countOccurrences("ab", "abcdef")).toBe(0);
  });
});

describe("bodyOccurrences", () => {
  it("yields one entry per occurrence, with the occurrence index within each line", () => {
    expect(bodyOccurrences(["aa-aa", "x", "a"], "aa")).toEqual([
      { line: 0, occ: 0 },
      { line: 0, occ: 1 },
    ]);
  });
  it("counts multiple occurrences on the same long line (not once per line)", () => {
    expect(bodyOccurrences(["aXaXaXa"], "a")).toEqual([
      { line: 0, occ: 0 },
      { line: 0, occ: 1 },
      { line: 0, occ: 2 },
      { line: 0, occ: 3 },
    ]);
  });
  it("is case-insensitive by default and exact-case when requested", () => {
    expect(bodyOccurrences(["AaAa"], "a")).toHaveLength(4);
    expect(bodyOccurrences(["AaAa"], "a", true)).toEqual([
      { line: 0, occ: 0 },
      { line: 0, occ: 1 },
    ]);
  });
  it("returns [] for an empty query", () => {
    expect(bodyOccurrences(["anything"], "")).toEqual([]);
  });
  it("caps at 5000 occurrences", () => {
    expect(bodyOccurrences(["a".repeat(6000)], "a")).toHaveLength(5000);
  });
});

describe("headerMatches", () => {
  it("matches name and value separately, one entry per occurrence", () => {
    expect(headerMatches(HEADERS, "aa")).toEqual([{ row: 1, field: 0, occ: 0 }]);
    expect(headerMatches(HEADERS, "x-")).toEqual([
      { row: 1, field: 0, occ: 0 },
      { row: 2, field: 0, occ: 0 },
    ]);
  });
  it("counts multiple occurrences within a single field, not just one per line", () => {
    expect(headerMatches([["x-id", "aa-aa-aa"]], "aa")).toEqual([
      { row: 0, field: 1, occ: 0 },
      { row: 0, field: 1, occ: 1 },
      { row: 0, field: 1, occ: 2 },
    ]);
  });
  it("never matches across the name/value boundary", () => {
    expect(headerMatches(HEADERS, "type: app")).toEqual([]);
  });
  it("respects case sensitivity across name and value", () => {
    const headers: [string, string][] = [["X-Ab", "abab"]];
    expect(headerMatches(headers, "ab", true)).toEqual([
      { row: 0, field: 1, occ: 0 },
      { row: 0, field: 1, occ: 1 },
    ]);
    expect(headerMatches(headers, "X-AB", true)).toEqual([]);
  });
  it("returns [] for empty query", () => {
    expect(headerMatches(HEADERS, "")).toEqual([]);
  });
});

describe("combineMatches scope filtering", () => {
  it("scope=url only counts URL occurrences", () => {
    const m = combineMatches(URL, HEADERS, 7, "aa", "url");
    expect(m.url).toBe(2);
    expect(m.headers).toEqual([]);
    expect(m.body).toBe(0);
    expect(m.total).toBe(2);
  });
  it("scope=headers only counts matching header occurrences", () => {
    const m = combineMatches(URL, HEADERS, 7, "aa", "headers");
    expect(m.url).toBe(0);
    expect(m.headers).toEqual([{ row: 1, field: 0, occ: 0 }]);
    expect(m.body).toBe(0);
    expect(m.total).toBe(1);
  });
  it("scope=body only counts the reported body matches", () => {
    const m = combineMatches(URL, HEADERS, 7, "aa", "body");
    expect(m.url).toBe(0);
    expect(m.headers).toEqual([]);
    expect(m.body).toBe(7);
    expect(m.total).toBe(7);
  });
  it("scope=all sums url + header occurrences + body", () => {
    const m = combineMatches(URL, HEADERS, 7, "aa", "all");
    expect(m.url).toBe(2);
    expect(m.headers).toEqual([{ row: 1, field: 0, occ: 0 }]);
    expect(m.body).toBe(7);
    expect(m.total).toBe(10);
  });
  it("scope=headers does not leak body matches when no header matches", () => {
    const m = combineMatches(URL, HEADERS, 7, "no-header-has-this", "headers");
    expect(m.headers).toEqual([]);
    expect(m.body).toBe(0);
    expect(m.total).toBe(0);
    expect(m.regionForIndex(0)).toBeNull();
  });
});

describe("combineMatches case sensitivity", () => {
  const url = "https://aa.example.com/AA?x=aa";
  const headers: [string, string][] = [["X-AA", "AA"]];

  it("counts case-insensitively by default", () => {
    const m = combineMatches(url, headers, 0, "aa", "all");
    expect(m.url).toBe(3);
    expect(m.headers).toEqual([
      { row: 0, field: 0, occ: 0 },
      { row: 0, field: 1, occ: 0 },
    ]);
    expect(m.total).toBe(5);
  });
  it("counts only exact-case occurrences when case-sensitive", () => {
    const m = combineMatches(url, headers, 0, "aa", "all", true);
    expect(m.url).toBe(2);
    expect(m.headers).toEqual([]);
    expect(m.total).toBe(2);
  });
});

describe("combineMatches empty query", () => {
  it("yields a total of 0 and no region for any index", () => {
    const m = combineMatches(URL, HEADERS, 7, "", "all");
    expect(m.total).toBe(0);
    expect(m.regionForIndex(0)).toBeNull();
  });
});

describe("combineMatches index -> region mapping", () => {
  const m = combineMatches(URL, HEADERS, 3, "aa", "all");

  it("maps URL indices first", () => {
    expect(m.regionForIndex(0)).toEqual({ region: "url", localIndex: 0 });
    expect(m.regionForIndex(1)).toEqual({ region: "url", localIndex: 1 });
  });
  it("maps header occurrences after URL, carrying row/field/occ", () => {
    expect(m.regionForIndex(2)).toEqual({ region: "header", localIndex: 1, field: 0, occ: 0 });
  });
  it("maps body indices last, zero-based within the body region", () => {
    expect(m.regionForIndex(3)).toEqual({ region: "body", localIndex: 0 });
    expect(m.regionForIndex(4)).toEqual({ region: "body", localIndex: 1 });
    expect(m.regionForIndex(5)).toEqual({ region: "body", localIndex: 2 });
  });
  it("returns null out of range", () => {
    expect(m.regionForIndex(-1)).toBeNull();
    expect(m.regionForIndex(6)).toBeNull();
  });
});

describe("combineMatches scope change clamps total", () => {
  it("a valid index under 'all' can exceed the total of a narrower scope", () => {
    const all = combineMatches(URL, HEADERS, 7, "aa", "all");
    const body = combineMatches(URL, HEADERS, 7, "aa", "body");
    const wasValid = all.total - 1;
    expect(all.regionForIndex(wasValid)).not.toBeNull();
    expect(body.regionForIndex(wasValid)).toBeNull();
    expect(Math.min(wasValid, body.total - 1)).toBeLessThan(body.total);
  });
});
