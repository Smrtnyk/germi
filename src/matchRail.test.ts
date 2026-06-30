import { describe, expect, it } from "vitest";
import { bandsToGradient, indexForFraction, railBands, railVisible } from "./matchRail";

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f${i}`);
}

describe("railBands", () => {
  it("returns empty for no flows or no bands", () => {
    expect(railBands([], new Set(), 120)).toEqual([]);
    expect(railBands(ids(10), new Set(), 0)).toEqual([]);
  });

  it("caps band count at the number of flows", () => {
    expect(railBands(ids(4), new Set(), 120)).toHaveLength(4);
  });

  it("reports per-band match fraction", () => {
    const all = railBands(ids(4), new Set(["f0", "f1", "f2", "f3"]), 4);
    expect(all).toEqual([1, 1, 1, 1]);
    const none = railBands(ids(4), new Set(), 4);
    expect(none).toEqual([0, 0, 0, 0]);
  });

  it("locates matches in the right half of the rail", () => {
    const bands = railBands(ids(100), new Set(["f80", "f90"]), 10);
    expect(bands.slice(0, 8).every((v) => v === 0)).toBe(true);
    expect(bands[8]).toBeGreaterThan(0);
    expect(bands[9]).toBeGreaterThan(0);
  });
});

describe("bandsToGradient", () => {
  it("is transparent with no bands", () => {
    expect(bandsToGradient([])).toBe("transparent");
  });

  it("emits two stops per band and tints only lit bands", () => {
    const g = bandsToGradient([0, 1]);
    expect(g.startsWith("linear-gradient(to bottom,")).toBe(true);
    expect(g).toContain("transparent 0.00%");
    expect(g).toContain("rgba(45, 212, 191,");
    expect(g.match(/%/g)).toHaveLength(4);
  });

  it("ramps opacity above a visible floor with density", () => {
    const faint = bandsToGradient([0.01]);
    const solid = bandsToGradient([1]);
    expect(faint).toContain("rgba(45, 212, 191, 0.35");
    expect(solid).toContain("rgba(45, 212, 191, 1.000)");
  });
});

describe("indexForFraction", () => {
  it("maps the rail extent onto flow indices", () => {
    expect(indexForFraction(0, 100)).toBe(0);
    expect(indexForFraction(1, 100)).toBe(99);
    expect(indexForFraction(0.5, 101)).toBe(50);
  });

  it("clamps out-of-range fractions and empty lists", () => {
    expect(indexForFraction(-1, 100)).toBe(0);
    expect(indexForFraction(2, 100)).toBe(99);
    expect(indexForFraction(0.5, 0)).toBe(0);
  });
});

describe("railVisible", () => {
  it("hides without matches or flows", () => {
    expect(railVisible(0, 100)).toBe(false);
    expect(railVisible(5, 0)).toBe(false);
  });

  it("shows for a useful match density", () => {
    expect(railVisible(5, 100)).toBe(true);
  });

  it("hides when almost everything matches", () => {
    expect(railVisible(99, 100)).toBe(false);
  });
});
