import { describe, expect, it } from "vitest";

import {
  alphaByteToPercent,
  alphaPercentToByte,
  compositeHex8,
  contrastRatio,
  cssVarUpdates,
  effectiveColor,
  HIGHLIGHT_COLORS,
  joinHex8,
  normalizeHex8,
  parseHexEntry,
  readableHighlightForeground,
  relativeLuminance,
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
      s.foregroundVar,
      ...(s.derivedVar ? [s.derivedVar] : []),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(vars).size).toBe(vars.length);
    for (const s of HIGHLIGHT_COLORS) {
      for (const value of Object.values(s.defaultValues)) expect(normalizeHex8(value)).toBe(value);
    }
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
      for (const value of Object.values(s.defaultValues)) {
        expect(joinHex8(splitHex8(value)), s.key).toBe(value);
      }
    }
  });

  it("maps alpha to whole percent and clamps on join", () => {
    expect(splitHex8("#173a36ff")).toEqual({ hex: "#173a36", alphaPct: 100 });
    expect(splitHex8("#173a3600").alphaPct).toBe(0);
    expect(joinHex8({ hex: "#173A36", alphaPct: 250 })).toBe("#173a36ff");
    expect(joinHex8({ hex: "#173a36", alphaPct: -4 })).toBe("#173a3600");
  });

  it("canonicalizes every alpha byte through the stable whole-percent contract", () => {
    for (let alphaByte = 0; alphaByte <= 255; alphaByte += 1) {
      // Integer forms of round(byte * 100 / 255), then
      // round(percent * 255 / 100), shared with proxy-core.
      const expectedPercent = Math.floor((alphaByte * 100 + 127) / 255);
      const expectedByte = Math.floor((expectedPercent * 255 + 50) / 100);
      const input = `#112233${alphaByte.toString(16).padStart(2, "0")}`;
      const canonical = `#112233${expectedByte.toString(16).padStart(2, "0")}`;

      expect(alphaByteToPercent(alphaByte), input).toBe(expectedPercent);
      expect(alphaPercentToByte(expectedPercent), input).toBe(expectedByte);
      expect(joinHex8(splitHex8(input)), input).toBe(canonical);
      expect(joinHex8(splitHex8(canonical)), input).toBe(canonical);
    }

    expect(joinHex8(splitHex8("#11223301"))).toBe("#11223300");
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
    expect(withOverride(prior, SEL, SEL.defaultValues.dark)).toEqual({});
    expect(withOverride(prior, SEL, SEL.defaultValues.light, "light")).toEqual({});
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
    expect(updates).toHaveLength(20);
    expect(updates.every((u) => u.value === null)).toBe(true);
  });

  it("derives readable custom foregrounds only for light mode", () => {
    const dark = cssVarUpdates({ selected: "#ff000080" }, "dark");
    expect(dark.find((u) => u.cssVar === "--sel-bg")?.value).toBe("#ff000080");
    expect(dark.find((u) => u.cssVar === "--sel-fg")?.value).toBeNull();
    expect(dark.filter((u) => u.value !== null)).toHaveLength(1);

    const light = cssVarUpdates({ selected: "#ff000080" }, "light");
    expect(light.find((u) => u.cssVar === "--sel-fg")?.value).not.toBeNull();
    expect(light.filter((u) => u.value !== null)).toHaveLength(2);
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
    expect(effectiveColor({}, ADD)).toBe(ADD.defaultValues.dark);
    expect(effectiveColor({}, ADD, "light")).toBe(ADD.defaultValues.light);
    expect(effectiveColor({ diffAdded: "chartreuse" }, ADD)).toBe(ADD.defaultValues.dark);
  });
});

describe("contrast helpers", () => {
  it("computes WCAG luminance and contrast for known endpoints", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(compositeHex8("#ffffff80", "#000000")).toBe("#808080");
  });

  it("keeps arbitrary stored tints readable in the light theme", () => {
    const surface = "#f6f8fb";
    const samples = [0, 17, 51, 85, 119, 153, 187, 221, 255];
    const colors = samples.flatMap((r) =>
      samples.flatMap((g) =>
        samples.flatMap((b) =>
          samples.map(
            (alpha) =>
              `#${[r, g, b, alpha].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
          ),
        ),
      ),
    );
    for (const color of colors) {
      const foreground = readableHighlightForeground(color, "light");
      const composite = compositeHex8(color, surface);
      expect(contrastRatio(foreground, composite), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("handles the midpoint that fails with near-black", () => {
    const foreground = readableHighlightForeground("#777777ff", "light");
    expect(foreground).toBe("#000000");
    expect(contrastRatio(foreground, "#777777")).toBeGreaterThanOrEqual(4.5);
  });
});
