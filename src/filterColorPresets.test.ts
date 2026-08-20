import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTER_COLOR_PRESETS,
  FILTER_COLOR_PRESET_COUNT,
  filterColorPresetParts,
} from "./filterColorPresets";
import { compositeHex8, contrastRatio, joinHex8, normalizeHex8 } from "./theme";

interface Oklab {
  l: number;
  a: number;
  b: number;
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rgb(value: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function oklab(value: string): Oklab {
  const [r, g, b] = rgb(value).map(linearChannel);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function distance(first: Oklab, second: Oklab): number {
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
}

function pairDistances(values: string[]): number[] {
  const colors = values.map(oklab);
  return colors.flatMap((first, index) =>
    colors.slice(index + 1).map((second) => distance(first, second)),
  );
}

describe("default filter color presets", () => {
  it("contains ten unique normalized full tints with lossless percent alpha rounding", () => {
    expect(DEFAULT_FILTER_COLOR_PRESETS).toHaveLength(FILTER_COLOR_PRESET_COUNT);
    expect(new Set(DEFAULT_FILTER_COLOR_PRESETS).size).toBe(FILTER_COLOR_PRESET_COUNT);
    expect(DEFAULT_FILTER_COLOR_PRESETS.every((value) => normalizeHex8(value) === value)).toBe(
      true,
    );
    expect(filterColorPresetParts(DEFAULT_FILTER_COLOR_PRESETS).map(joinHex8)).toEqual(
      DEFAULT_FILTER_COLOR_PRESETS,
    );
  });

  it.each([
    ["dark", "#0e1116", "#d7dee8"],
    ["light", "#f6f8fb", "#1b2636"],
  ])("keeps %s composites separated and normal row text readable", (_theme, background, text) => {
    const composites = DEFAULT_FILTER_COLOR_PRESETS.map((value) =>
      compositeHex8(value, background),
    );
    expect(Math.min(...pairDistances(composites))).toBeGreaterThanOrEqual(0.03);
    expect(
      Math.min(...composites.map((composite) => contrastRatio(text, composite))),
    ).toBeGreaterThanOrEqual(7);
  });
});
