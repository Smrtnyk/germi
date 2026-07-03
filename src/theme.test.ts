import { describe, expect, it } from "vitest";

import {
  cssVarUpdates,
  effectiveColor,
  HIGHLIGHT_COLORS,
  joinHex8,
  normalizeHex8,
  parseHexEntry,
  splitHex8,
  withOverride,
} from "./theme";

const SEL = HIGHLIGHT_COLORS.find((s) => s.key === "selected")!;
const ADD = HIGHLIGHT_COLORS.find((s) => s.key === "diffAdded")!;

describe("HIGHLIGHT_COLORS registry", () => {
  it("has unique keys and css vars, and canonical defaults", () => {
    const keys = HIGHLIGHT_COLORS.map((s) => s.key);
    const vars = HIGHLIGHT_COLORS.flatMap((s) => [
      s.cssVar,
      ...(s.derivedVar ? [s.derivedVar] : []),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(vars).size).toBe(vars.length);
    for (const s of HIGHLIGHT_COLORS) expect(normalizeHex8(s.defaultValue)).toBe(s.defaultValue);
  });
});

describe("normalizeHex8", () => {
  it("accepts #rrggbbaa (any case) and opaque #rrggbb", () => {
    expect(normalizeHex8("#173A36FF")).toBe("#173a36ff");
    expect(normalizeHex8(" #60a5fa21 ")).toBe("#60a5fa21");
    expect(normalizeHex8("#173a36")).toBe("#173a36ff");
  });

  it("rejects everything else", () => {
    for (const bad of ["", "#fff", "#12345", "rgba(1,2,3,0.5)", "teal", "#gggggggg"]) {
      expect(normalizeHex8(bad), bad).toBeNull();
    }
  });
});

describe("splitHex8 / joinHex8", () => {
  it("round-trips every default through the picker + slider parts", () => {
    for (const s of HIGHLIGHT_COLORS) {
      expect(joinHex8(splitHex8(s.defaultValue)), s.key).toBe(s.defaultValue);
    }
  });

  it("maps alpha to whole percent and clamps on join", () => {
    expect(splitHex8("#173a36ff")).toEqual({ hex: "#173a36", alphaPct: 100 });
    expect(splitHex8("#173a3600").alphaPct).toBe(0);
    expect(joinHex8({ hex: "#173A36", alphaPct: 250 })).toBe("#173a36ff");
    expect(joinHex8({ hex: "#173a36", alphaPct: -4 })).toBe("#173a3600");
  });
});

describe("parseHexEntry", () => {
  it("keeps the fallback alpha for a 6-digit hex, with or without #", () => {
    expect(parseHexEntry("#FF8800", 13)).toEqual({ hex: "#ff8800", alphaPct: 13 });
    expect(parseHexEntry("ff8800", 9)).toEqual({ hex: "#ff8800", alphaPct: 9 });
    expect(parseHexEntry("  #ff8800  ", 5)).toEqual({ hex: "#ff8800", alphaPct: 5 });
  });

  it("takes alpha from an explicit 8-digit hex", () => {
    expect(parseHexEntry("#ff880066", 13)).toEqual({ hex: "#ff8800", alphaPct: 40 });
    expect(parseHexEntry("11223380", 100)).toEqual({ hex: "#112233", alphaPct: 50 });
  });

  it("rejects everything else", () => {
    for (const bad of ["", "#fff", "#12345", "chartreuse", "rgba(1,2,3,0.5)", "#ff88zz"]) {
      expect(parseHexEntry(bad, 50), bad).toBeNull();
    }
  });
});

describe("withOverride", () => {
  it("stores normalized values and clears on null", () => {
    const set = withOverride({}, SEL, "#FF000080");
    expect(set).toEqual({ selected: "#ff000080" });
    expect(withOverride(set, SEL, null)).toEqual({});
  });

  it("collapses default-equal and invalid values to no override", () => {
    const prior = { selected: "#ff000080" };
    expect(withOverride(prior, SEL, SEL.defaultValue)).toEqual({});
    expect(withOverride(prior, SEL, "nonsense")).toEqual({});
    expect(prior).toEqual({ selected: "#ff000080" });
  });

  it("leaves other overrides alone", () => {
    expect(withOverride({ diffAdded: "#11223344" }, SEL, "#ff000080")).toEqual({
      diffAdded: "#11223344",
      selected: "#ff000080",
    });
  });
});

describe("cssVarUpdates", () => {
  it("covers every owned var, removing all with no overrides", () => {
    const updates = cssVarUpdates({});
    expect(updates).toHaveLength(11);
    expect(updates.every((u) => u.value === null)).toBe(true);
  });

  it("sets an overridden var and leaves the rest as removals", () => {
    const updates = cssVarUpdates({ selected: "#ff000080" });
    expect(updates.find((u) => u.cssVar === "--sel-bg")?.value).toBe("#ff000080");
    expect(updates.filter((u) => u.value !== null)).toHaveLength(1);
  });

  it("derives the intra-line diff mark at 3x alpha, capped", () => {
    const scaled = cssVarUpdates({ diffAdded: "#34d39917" });
    expect(scaled.find((u) => u.cssVar === "--diff-add-hl")?.value).toBe("#34d39945");
    const capped = cssVarUpdates({ diffRemoved: "#f8717199" });
    expect(capped.find((u) => u.cssVar === "--diff-del-hl")?.value).toBe("#f87171ff");
    expect(cssVarUpdates({}).find((u) => u.cssVar === "--diff-add-hl")?.value).toBeNull();
  });

  it("ignores unknown keys and treats invalid values as unset", () => {
    expect(cssVarUpdates({ bogus: "#11223344" }).every((u) => u.value === null)).toBe(true);
    expect(cssVarUpdates({ selected: "nonsense" }).every((u) => u.value === null)).toBe(true);
  });
});

describe("effectiveColor", () => {
  it("prefers a valid override, normalizing opaque hex", () => {
    expect(effectiveColor({ diffAdded: "#112233" }, ADD)).toBe("#112233ff");
  });

  it("falls back to the default when absent or invalid", () => {
    expect(effectiveColor({}, ADD)).toBe(ADD.defaultValue);
    expect(effectiveColor({ diffAdded: "chartreuse" }, ADD)).toBe(ADD.defaultValue);
  });
});
