import { describe, expect, it } from "vitest";

import { summary } from "./flowFixtures";
import {
  applyVisibility,
  combineMatches,
  compileFilters,
  computeFilterMatches,
  FILTER_COLORS,
  hasContentTerms,
  nextFilterColor,
  sanitizeSavedFilters,
  savedFilterLabel,
  type FilterMatches,
  type SavedFilter,
} from "./savedFilters";
import type { FlowSummary } from "./types";

function saved(overrides: Partial<SavedFilter> = {}): SavedFilter {
  return {
    id: "f1",
    query: "",
    kinds: [],
    statuses: [],
    color: "#e879f9",
    highlight: true,
    ...overrides,
  };
}

function matches(flows: FlowSummary[], filters: SavedFilter[]): FilterMatches {
  return computeFilterMatches(flows, filters, compileFilters(filters));
}

describe("sanitizeSavedFilters", () => {
  it("returns empty for non-arrays and garbage", () => {
    expect(sanitizeSavedFilters(null)).toEqual([]);
    expect(sanitizeSavedFilters("nope")).toEqual([]);
    expect(sanitizeSavedFilters({ 0: {} })).toEqual([]);
  });

  it("keeps valid entries and drops malformed ones", () => {
    const out = sanitizeSavedFilters([
      { id: "a", query: "host:x", kinds: ["xhr"], statuses: ["4xx"], color: "#abc123" },
      { id: "", query: "broken" },
      { query: "no id" },
      42,
      { id: "b", query: "" },
    ]);
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out[0]).toEqual({
      id: "a",
      query: "host:x",
      kinds: ["xhr"],
      statuses: ["4xx"],
      color: "#abc123",
      highlight: true,
    });
  });

  it("repairs bad colors, drops unknown chip values and duplicate ids", () => {
    const out = sanitizeSavedFilters([
      {
        id: "a",
        query: "",
        color: "red",
        kinds: [7, "doc", "fetch"],
        statuses: ["4xx", "teapot"],
        highlight: false,
      },
      { id: "a", query: "dupe" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].color).toBe(FILTER_COLORS[0]);
    expect(out[0].kinds).toEqual(["doc"]);
    expect(out[0].statuses).toEqual(["4xx"]);
    expect(out[0].highlight).toBe(false);
  });
});

describe("nextFilterColor", () => {
  it("picks the first unused palette color", () => {
    expect(nextFilterColor([])).toBe(FILTER_COLORS[0]);
    expect(nextFilterColor([saved({ color: FILTER_COLORS[0] })])).toBe(FILTER_COLORS[1]);
  });

  it("cycles once the palette is exhausted", () => {
    const all = FILTER_COLORS.map((color, i) => saved({ id: `f${i}`, color }));
    expect(nextFilterColor(all)).toBe(FILTER_COLORS[all.length % FILTER_COLORS.length]);
  });
});

describe("savedFilterLabel", () => {
  it("joins the query with the chip names", () => {
    const f = saved({ query: " host:api ", kinds: ["xhr"], statuses: ["4xx"] });
    expect(savedFilterLabel(f)).toBe("host:api xhr 4xx");
  });

  it("falls back for an empty filter", () => {
    expect(savedFilterLabel(saved())).toBe("(everything)");
  });
});

describe("hasContentTerms", () => {
  it("detects backend-scan terms and ignores summary terms", () => {
    expect(hasContentTerms("body:token")).toBe(true);
    expect(hasContentTerms("resp-header:etag host:x")).toBe(true);
    expect(hasContentTerms("host:x status:4xx")).toBe(false);
  });
});

describe("computeFilterMatches", () => {
  const flows = [
    summary({ id: "1", host: "api.example.com", kind: "xhr" }),
    summary({ id: "2", host: "cdn.example.com", kind: "img" }),
    summary({ id: "3", host: "api.example.com", kind: "xhr", status: 404 }),
  ];

  it("tints matching rows with the first matching filter in list order", () => {
    const filters = [
      saved({ id: "a", query: "status:4xx", color: "#ff0000" }),
      saved({ id: "b", query: "host:api", color: "#00ff00" }),
    ];
    const { tints, counts } = matches(flows, filters);
    expect(tints.get("3")?.color).toBe("#ff0000");
    expect(tints.get("1")?.color).toBe("#00ff00");
    expect(tints.has("2")).toBe(false);
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(2);
  });

  it("counts matches for non-highlighting filters without tinting", () => {
    const filters = [saved({ id: "a", query: "host:api", highlight: false })];
    const { tints, counts } = matches(flows, filters);
    expect(tints.size).toBe(0);
    expect(counts.get("a")).toBe(2);
  });

  it("matches on the stored kind/status chips too", () => {
    const filters = [saved({ id: "a", kinds: ["img"] })];
    const { tints, counts } = matches(flows, filters);
    expect(counts.get("a")).toBe(1);
    expect(tints.get("2")?.label).toBe("img");
  });

  it("skips content-term filters entirely and reports no count", () => {
    const filters = [saved({ id: "a", query: "host:api body:secret" })];
    const { tints, counts } = matches(flows, filters);
    expect(compileFilters(filters)).toEqual([]);
    expect(tints.size).toBe(0);
    expect(counts.get("a")).toBeNull();
  });
});

describe("combineMatches", () => {
  it("passes through when one side is inactive", () => {
    expect(combineMatches(null, null)).toBeNull();
    const only = new Set(["1"]);
    expect(combineMatches(only, null)).toBe(only);
    expect(combineMatches(null, only)).toBe(only);
  });

  it("intersects two active sides", () => {
    const both = combineMatches(new Set(["1", "2"]), new Set(["2", "3"]));
    expect([...(both ?? [])]).toEqual(["2"]);
  });
});

describe("applyVisibility", () => {
  const flows = [summary({ id: "1" }), summary({ id: "2" }), summary({ id: "3" })];

  it("hide mode removes non-matching rows and disables dimming", () => {
    const view = applyVisibility(flows, "hide", new Set(["2"]), null);
    expect(view.visible.map((f) => f.id)).toEqual(["2"]);
    expect(view.listMatched).toBeNull();
  });

  it("dim mode keeps all rows and dims against the bar matches", () => {
    const bar = new Set(["2"]);
    const view = applyVisibility(flows, "dim", bar, null);
    expect(view.visible.map((f) => f.id)).toEqual(["1", "2", "3"]);
    expect(view.listMatched).toBe(bar);
  });

  it("a solo'd filter narrows the list even in dim mode", () => {
    const view = applyVisibility(flows, "dim", new Set(["1", "2"]), new Set(["2", "3"]));
    expect(view.visible.map((f) => f.id)).toEqual(["2", "3"]);
    expect([...(view.listMatched ?? [])]).toEqual(["1", "2"]);
  });

  it("hide mode intersects the bar filter with the solo'd filter", () => {
    const view = applyVisibility(flows, "hide", new Set(["1", "2"]), new Set(["2", "3"]));
    expect(view.visible.map((f) => f.id)).toEqual(["2"]);
  });

  it("shows everything when no filter is active", () => {
    const view = applyVisibility(flows, "hide", null, null);
    expect(view.visible).toHaveLength(3);
    expect(view.listMatched).toBeNull();
  });
});
