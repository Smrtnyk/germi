import defaults from "../filter-color-presets.json";

import { joinHex8, splitHex8, type ColorParts } from "./theme";

export const FILTER_COLOR_PRESET_COUNT = 10;

/** Shared hard-coded palette. Rust includes the same JSON when it builds the
 *  authoritative settings default, so first paint and persisted settings cannot drift. */
export const DEFAULT_FILTER_COLOR_PRESETS: readonly string[] = Object.freeze([...defaults]);

export function filterColorPresetParts(values: readonly string[]): ColorParts[] {
  return values.map(splitHex8);
}

export function sameColorParts(first: ColorParts, second: ColorParts): boolean {
  return joinHex8(first) === joinHex8(second);
}
