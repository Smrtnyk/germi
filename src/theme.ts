import { clamp } from "es-toolkit";

/**
 * Configurable highlight colors (issue #93). Every row/diff highlight in the
 * app is a `:root` custom property in `styles.css`; user overrides live as a
 * sparse `#rrggbbaa` map in `ProxySettings.highlightColors` and are applied
 * per window as inline custom properties on `<html>`, so an absent key falls
 * back to the stylesheet default. `defaultValue` mirrors the `:root` value
 * (guarded by a test that parses `styles.css`).
 */
export interface HighlightColorSpec {
  /** Key in `ProxySettings.highlightColors`. */
  key: string;
  /** The custom property the override lands on. */
  cssVar: string;
  /** Stronger companion derived at 3× alpha (intra-line diff change marks). */
  derivedVar?: string;
  label: string;
  group: "rows" | "diff";
  /** The `:root` default as `#rrggbbaa`. */
  defaultValue: string;
}

export const HIGHLIGHT_COLORS: HighlightColorSpec[] = [
  {
    key: "selected",
    cssVar: "--sel-bg",
    label: "Selected row",
    group: "rows",
    defaultValue: "#173a36ff",
  },
  {
    key: "multiSelected",
    cssVar: "--sel-multi-bg",
    label: "Multi-selected rows",
    group: "rows",
    defaultValue: "#60a5fa21",
  },
  {
    key: "filterMatch",
    cssVar: "--row-match-bg",
    label: "Filter-matched rows",
    group: "rows",
    defaultValue: "#2dd4bf14",
  },
  {
    key: "mockedRow",
    cssVar: "--row-mock-bg",
    label: "Mocked rows",
    group: "rows",
    defaultValue: "#2dd4bf0d",
  },
  {
    key: "importedRow",
    cssVar: "--row-imported-bg",
    label: "Imported rows",
    group: "rows",
    defaultValue: "#a78bfa0f",
  },
  {
    key: "compareMatchLeft",
    cssVar: "--match-a-bg",
    label: "URL match — left pane",
    group: "diff",
    defaultValue: "#2dd4bf14",
  },
  {
    key: "compareMatchRight",
    cssVar: "--match-b-bg",
    label: "URL match — right pane",
    group: "diff",
    defaultValue: "#60a5fa17",
  },
  {
    key: "diffAdded",
    cssVar: "--diff-add-bg",
    derivedVar: "--diff-add-hl",
    label: "Diff — added lines",
    group: "diff",
    defaultValue: "#34d39917",
  },
  {
    key: "diffRemoved",
    cssVar: "--diff-del-bg",
    derivedVar: "--diff-del-hl",
    label: "Diff — removed lines",
    group: "diff",
    defaultValue: "#f871711a",
  },
];

/** The intra-line change mark is this much denser than its line background
 *  (mirrors the stylesheet ratio, e.g. 0.09 → 0.28). */
const DERIVED_ALPHA_SCALE = 3;

/** Accept what we write (`#rrggbbaa`) plus hand-edited opaque `#rrggbb`. */
export function normalizeHex8(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{8}$/.test(v)) return v;
  if (/^#[0-9a-f]{6}$/.test(v)) return `${v}ff`;
  return null;
}

export interface ColorParts {
  /** `#rrggbb`, what `<input type="color">` speaks. */
  hex: string;
  /** Opacity 0–100 for the slider. */
  alphaPct: number;
}

export function splitHex8(value: string): ColorParts {
  return {
    hex: value.slice(0, 7),
    alphaPct: Math.round((parseInt(value.slice(7, 9), 16) * 100) / 255),
  };
}

export function joinHex8({ hex, alphaPct }: ColorParts): string {
  const byte = Math.round((clamp(alphaPct, 0, 100) * 255) / 100);
  return `${hex.toLowerCase()}${byte.toString(16).padStart(2, "0")}`;
}

/** The color a spec currently shows: its valid override, else its default. */
export function effectiveColor(
  overrides: Record<string, string>,
  spec: HighlightColorSpec,
): string {
  const raw = overrides[spec.key];
  return (raw === undefined ? null : normalizeHex8(raw)) ?? spec.defaultValue;
}

/**
 * Return `overrides` with `spec` set to `value` (or cleared for `null`),
 * normalized and kept sparse: a value equal to the default is stored as "no
 * override" so the map only ever holds real customizations.
 */
export function withOverride(
  overrides: Record<string, string>,
  spec: HighlightColorSpec,
  value: string | null,
): Record<string, string> {
  const next = { ...overrides };
  const norm = value === null ? null : normalizeHex8(value);
  if (norm === null || norm === spec.defaultValue) delete next[spec.key];
  else next[spec.key] = norm;
  return next;
}

export interface CssVarUpdate {
  cssVar: string;
  /** `null` = remove the inline override (stylesheet default wins). */
  value: string | null;
}

function scaleAlpha(hex8: string, factor: number): string {
  const byte = Math.min(255, Math.round(parseInt(hex8.slice(7, 9), 16) * factor));
  return `${hex8.slice(0, 7)}${byte.toString(16).padStart(2, "0")}`;
}

/** Every custom property this feature owns, with the value it should have
 *  under `overrides` — unknown keys ignored, invalid values treated as unset. */
export function cssVarUpdates(overrides: Record<string, string>): CssVarUpdate[] {
  return HIGHLIGHT_COLORS.flatMap((spec) => {
    const raw = overrides[spec.key];
    const value = raw === undefined ? null : normalizeHex8(raw);
    const updates: CssVarUpdate[] = [{ cssVar: spec.cssVar, value }];
    if (spec.derivedVar) {
      updates.push({
        cssVar: spec.derivedVar,
        value: value === null ? null : scaleAlpha(value, DERIVED_ALPHA_SCALE),
      });
    }
    return updates;
  });
}

/** Apply the overrides to this window (inline custom properties on `<html>`). */
export function applyHighlightColors(overrides: Record<string, string>): void {
  const style = document.documentElement.style;
  for (const { cssVar, value } of cssVarUpdates(overrides)) {
    if (value === null) style.removeProperty(cssVar);
    else style.setProperty(cssVar, value);
  }
}
