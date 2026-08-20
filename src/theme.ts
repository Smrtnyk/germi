import { clamp } from "es-toolkit";
import { useSyncExternalStore } from "react";

import type { Theme, ThemePreference } from "./types";

const DEFAULT_THEME: Theme = "dark";
const THEME_CACHE_KEY = "germi.theme-cache";
const THEME_PREFERENCE_CACHE_KEY = "germi.theme-preference-cache";

const THEME_SURFACES: Record<Theme, string> = {
  dark: "#0e1116",
  light: "#f6f8fb",
};
const READABLE_FOREGROUNDS = ["#000000", "#ffffff"] as const;
const SYSTEM_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Color tokens that every explicit theme must define. Browser coverage checks
 *  this registry against computed styles so new semantic surfaces cannot
 *  silently remain dark-only. */
export const REQUIRED_THEME_TOKENS = [
  "--bg",
  "--bg-1",
  "--bg-2",
  "--bg-3",
  "--line",
  "--line-subtle",
  "--text",
  "--muted",
  "--accent",
  "--accent-rgb",
  "--accent-dim",
  "--accent-hover",
  "--accent-bg",
  "--on-accent",
  "--danger",
  "--danger-line",
  "--on-danger",
  "--on-info",
  "--warn",
  "--imported",
  "--s2",
  "--s3",
  "--s4",
  "--s5",
  "--s2-bg",
  "--s3-bg",
  "--s4-bg",
  "--s5-bg",
  "--sel-bg",
  "--sel-fg",
  "--sel-multi-bg",
  "--sel-multi-fg",
  "--row-match-bg",
  "--row-match-fg",
  "--row-mock-bg",
  "--row-mock-fg",
  "--row-imported-bg",
  "--row-imported-fg",
  "--drop-overlay",
  "--bar-accent-bg",
  "--chip-on-bg",
  "--banner-warn-bg",
  "--banner-warn-line",
  "--diff-add-bg",
  "--diff-add-fg",
  "--diff-del-bg",
  "--diff-del-fg",
  "--diff-add-hl",
  "--diff-del-hl",
  "--match-a-bg",
  "--match-a-fg",
  "--match-b-bg",
  "--match-b-fg",
  "--error-bg",
  "--error-text",
  "--error-line",
  "--checker-a",
  "--checker-b",
  "--backdrop",
  "--shadow-soft",
  "--shadow-strong",
  "--outcome-respond-bg",
  "--outcome-block-bg",
  "--outcome-continue-bg",
  "--outcome-map-bg",
  "--find-hit-bg",
  "--find-active-bg",
  "--find-match-bg",
  "--find-match-text",
  "--find-active-match-bg",
  "--find-active-text",
  "--scrollbar-thumb",
  "--scrollbar-track",
] as const;

export interface ThemeContrastPair {
  foreground: string;
  background: string;
  minimum: number;
  /** Token underneath a translucent background. */
  surface?: string;
}

/** WCAG load-bearing pairs for the new light palette. Component boundaries
 *  use 3:1; text pairs use 4.5:1. */
export const LIGHT_THEME_CONTRAST_PAIRS: readonly ThemeContrastPair[] = [
  { foreground: "--text", background: "--bg", minimum: 4.5 },
  { foreground: "--text", background: "--bg-1", minimum: 4.5 },
  { foreground: "--text", background: "--bg-2", minimum: 4.5 },
  { foreground: "--text", background: "--bg-3", minimum: 4.5 },
  { foreground: "--muted", background: "--bg", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-1", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-2", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-3", minimum: 4.5 },
  { foreground: "--accent", background: "--bg", minimum: 4.5 },
  { foreground: "--accent", background: "--bg-1", minimum: 4.5 },
  { foreground: "--danger", background: "--bg", minimum: 4.5 },
  { foreground: "--warn", background: "--bg", minimum: 4.5 },
  { foreground: "--imported", background: "--bg", minimum: 4.5 },
  { foreground: "--s2", background: "--bg", minimum: 4.5 },
  { foreground: "--s3", background: "--bg", minimum: 4.5 },
  { foreground: "--s4", background: "--bg", minimum: 4.5 },
  { foreground: "--s5", background: "--bg", minimum: 4.5 },
  { foreground: "--on-accent", background: "--accent-dim", minimum: 4.5 },
  { foreground: "--on-danger", background: "--danger", minimum: 4.5 },
  { foreground: "--on-info", background: "--s3", minimum: 4.5 },
  { foreground: "--error-text", background: "--error-bg", minimum: 4.5 },
  { foreground: "--find-match-text", background: "--find-match-bg", minimum: 4.5 },
  { foreground: "--line", background: "--bg-2", minimum: 3 },
  { foreground: "--line", background: "--bg-3", minimum: 3 },
  { foreground: "--scrollbar-thumb", background: "--bg-1", minimum: 3 },
  { foreground: "--accent", background: "--bg-3", minimum: 4.5 },
  { foreground: "--danger", background: "--bg-3", minimum: 4.5 },
  { foreground: "--warn", background: "--bg-3", minimum: 4.5 },
  { foreground: "--imported", background: "--bg-3", minimum: 4.5 },
  { foreground: "--s2", background: "--bg-3", minimum: 4.5 },
  { foreground: "--s3", background: "--bg-3", minimum: 4.5 },
  { foreground: "--s4", background: "--bg-3", minimum: 4.5 },
  { foreground: "--s5", background: "--bg-3", minimum: 4.5 },
  { foreground: "--accent", background: "--chip-on-bg", minimum: 4.5 },
  { foreground: "--s2", background: "--s2-bg", minimum: 4.5 },
  { foreground: "--s3", background: "--s3-bg", minimum: 4.5 },
  { foreground: "--s4", background: "--s4-bg", minimum: 4.5 },
  { foreground: "--s5", background: "--s5-bg", minimum: 4.5 },
  { foreground: "--sel-fg", background: "--sel-bg", surface: "--bg", minimum: 4.5 },
  {
    foreground: "--sel-multi-fg",
    background: "--sel-multi-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--row-match-fg",
    background: "--row-match-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--row-mock-fg",
    background: "--row-mock-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--row-imported-fg",
    background: "--row-imported-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--match-a-fg",
    background: "--match-a-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--match-b-fg",
    background: "--match-b-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--diff-add-fg",
    background: "--diff-add-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  {
    foreground: "--diff-del-fg",
    background: "--diff-del-bg",
    surface: "--bg",
    minimum: 4.5,
  },
  { foreground: "--text", background: "--find-hit-bg", surface: "--bg", minimum: 4.5 },
  { foreground: "--text", background: "--find-active-bg", surface: "--bg", minimum: 4.5 },
  {
    foreground: "--find-active-text",
    background: "--find-active-match-bg",
    minimum: 4.5,
  },
  { foreground: "--accent", background: "--drop-overlay", surface: "--bg", minimum: 4.5 },
  { foreground: "--warn", background: "--banner-warn-bg", minimum: 4.5 },
  { foreground: "--accent", background: "--outcome-respond-bg", minimum: 4.5 },
  { foreground: "--danger", background: "--outcome-block-bg", minimum: 4.5 },
  { foreground: "--s3", background: "--outcome-continue-bg", minimum: 4.5 },
  { foreground: "--imported", background: "--outcome-map-bg", minimum: 4.5 },
] as const;

/** Existing dark pairs that already met WCAG before light mode was restored.
 *  Deliberately excludes legacy low-contrast decorative borders and scrollbar
 *  thumbs: their old computed appearance is protected by the dark baseline
 *  browser regression instead of being silently redesigned here. */
export const LEGACY_DARK_CONTRAST_PAIRS: readonly ThemeContrastPair[] = [
  { foreground: "--text", background: "--bg", minimum: 4.5 },
  { foreground: "--text", background: "--bg-1", minimum: 4.5 },
  { foreground: "--text", background: "--bg-2", minimum: 4.5 },
  { foreground: "--text", background: "--bg-3", minimum: 4.5 },
  { foreground: "--muted", background: "--bg", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-1", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-2", minimum: 4.5 },
  { foreground: "--muted", background: "--bg-3", minimum: 4.5 },
  { foreground: "--accent", background: "--bg", minimum: 4.5 },
  { foreground: "--accent", background: "--bg-1", minimum: 4.5 },
  { foreground: "--accent", background: "--bg-3", minimum: 4.5 },
  { foreground: "--danger", background: "--bg", minimum: 4.5 },
  { foreground: "--danger", background: "--bg-3", minimum: 4.5 },
  { foreground: "--warn", background: "--bg", minimum: 4.5 },
  { foreground: "--warn", background: "--bg-3", minimum: 4.5 },
  { foreground: "--imported", background: "--bg", minimum: 4.5 },
  { foreground: "--imported", background: "--bg-3", minimum: 4.5 },
  { foreground: "--s2", background: "--bg", minimum: 4.5 },
  { foreground: "--s3", background: "--bg", minimum: 4.5 },
  { foreground: "--s4", background: "--bg", minimum: 4.5 },
  { foreground: "--s5", background: "--bg", minimum: 4.5 },
  { foreground: "--on-accent", background: "--accent-dim", minimum: 4.5 },
  { foreground: "--on-danger", background: "--danger", minimum: 4.5 },
  { foreground: "--on-info", background: "--s3", minimum: 4.5 },
  { foreground: "--error-text", background: "--error-bg", minimum: 4.5 },
  { foreground: "--find-match-text", background: "--find-match-bg", minimum: 4.5 },
  {
    foreground: "--find-active-text",
    background: "--find-active-match-bg",
    minimum: 4.5,
  },
] as const;

/**
 * Configurable highlight colors (issue #93). Every row/diff highlight in the
 * app is a `:root` custom property in `styles.css`; user overrides live as a
 * sparse `#rrggbbaa` map in `ProxySettings.highlightColors` and are applied
 * per window as inline custom properties on `<html>`, so an absent key falls
 * back to the stylesheet default. `defaultValues` mirrors the two explicit
 * stylesheet themes (guarded by a real-browser computed-style test).
 */
export interface HighlightColorSpec {
  /** Key in `ProxySettings.highlightColors`. */
  key: string;
  /** The custom property the override lands on. */
  cssVar: string;
  /** Readable row/code foreground chosen for arbitrary custom colors. */
  foregroundVar: string;
  /** Stronger companion derived at 3× alpha (intra-line diff change marks). */
  derivedVar?: string;
  label: string;
  group: "rows" | "diff";
  /** Each theme's stylesheet default as `#rrggbbaa`. */
  defaultValues: Record<Theme, string>;
}

export const HIGHLIGHT_COLORS: HighlightColorSpec[] = [
  {
    key: "selected",
    cssVar: "--sel-bg",
    foregroundVar: "--sel-fg",
    label: "Selected row",
    group: "rows",
    defaultValues: { dark: "#173a36ff", light: "#c9eee8ff" },
  },
  {
    key: "multiSelected",
    cssVar: "--sel-multi-bg",
    foregroundVar: "--sel-multi-fg",
    label: "Multi-selected rows",
    group: "rows",
    defaultValues: { dark: "#60a5fa21", light: "#2563eb2e" },
  },
  {
    key: "filterMatch",
    cssVar: "--row-match-bg",
    foregroundVar: "--row-match-fg",
    label: "Filter-matched rows",
    group: "rows",
    defaultValues: { dark: "#2dd4bf14", light: "#0f766e24" },
  },
  {
    key: "mockedRow",
    cssVar: "--row-mock-bg",
    foregroundVar: "--row-mock-fg",
    label: "Mocked rows",
    group: "rows",
    defaultValues: { dark: "#2dd4bf0d", light: "#0f766e1a" },
  },
  {
    key: "importedRow",
    cssVar: "--row-imported-bg",
    foregroundVar: "--row-imported-fg",
    label: "Imported rows",
    group: "rows",
    defaultValues: { dark: "#a78bfa0f", light: "#6d43c51a" },
  },
  {
    key: "compareMatchLeft",
    cssVar: "--match-a-bg",
    foregroundVar: "--match-a-fg",
    label: "URL match — left pane",
    group: "diff",
    defaultValues: { dark: "#2dd4bf14", light: "#0f766e24" },
  },
  {
    key: "compareMatchRight",
    cssVar: "--match-b-bg",
    foregroundVar: "--match-b-fg",
    label: "URL match — right pane",
    group: "diff",
    defaultValues: { dark: "#60a5fa17", light: "#2563eb26" },
  },
  {
    key: "diffAdded",
    cssVar: "--diff-add-bg",
    foregroundVar: "--diff-add-fg",
    derivedVar: "--diff-add-hl",
    label: "Diff — added lines",
    group: "diff",
    defaultValues: { dark: "#34d39917", light: "#15803d1f" },
  },
  {
    key: "diffRemoved",
    cssVar: "--diff-del-bg",
    foregroundVar: "--diff-del-fg",
    derivedVar: "--diff-del-hl",
    label: "Diff — removed lines",
    group: "diff",
    defaultValues: { dark: "#f871711a", light: "#c6282821" },
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

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgbFromHex(value: string): Rgb {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected #rrggbb, got ${value}`);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = rgbFromHex(color);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio for two opaque sRGB `#rrggbb` colors. */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite a stored `#rrggbbaa` tint over an opaque surface. */
export function compositeHex8(foreground: string, background: string): string {
  const normalized = normalizeHex8(foreground);
  if (normalized === null) throw new Error(`Expected #rrggbbaa, got ${foreground}`);
  const fg = rgbFromHex(normalized.slice(0, 7));
  const bg = rgbFromHex(background);
  const alpha = parseInt(normalized.slice(7, 9), 16) / 255;
  const channel = (front: number, back: number) => Math.round(front * alpha + back * (1 - alpha));
  return `#${[channel(fg.r, bg.r), channel(fg.g, bg.g), channel(fg.b, bg.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Pick the higher-contrast light/dark foreground for an arbitrary stored tint.
 *  One of black/white always reaches 4.5:1, so custom hues stay untouched while
 *  light-theme row and diff text remains readable. Dark mode intentionally
 *  keeps the legacy foreground treatment. */
export function readableHighlightForeground(color: string, theme: Theme): string {
  const composite = compositeHex8(color, THEME_SURFACES[theme]);
  return READABLE_FOREGROUNDS.reduce((best, candidate) =>
    contrastRatio(candidate, composite) > contrastRatio(best, composite) ? candidate : best,
  );
}

export interface ColorParts {
  /** `#rrggbb`, what `<input type="color">` speaks. */
  hex: string;
  /** Opacity 0–100 for the slider. */
  alphaPct: number;
}

/** Round an 8-bit alpha into the picker's whole-percent domain.
 *  Keep this contract in sync with `proxy-core` settings normalization. */
export function alphaByteToPercent(alphaByte: number): number {
  return Math.round((clamp(alphaByte, 0, 255) * 100) / 255);
}

/** Round a picker percentage back to the one byte persisted in `#rrggbbaa`. */
export function alphaPercentToByte(alphaPct: number): number {
  return Math.round((clamp(alphaPct, 0, 100) * 255) / 100);
}

export function splitHex8(value: string): ColorParts {
  return {
    hex: value.slice(0, 7),
    alphaPct: alphaByteToPercent(parseInt(value.slice(7, 9), 16)),
  };
}

export function joinHex8({ hex, alphaPct }: ColorParts): string {
  const byte = alphaPercentToByte(alphaPct);
  return `${hex.toLowerCase()}${byte.toString(16).padStart(2, "0")}`;
}

/**
 * Parse a hand-typed or dropped hex entry (`#` optional, case-insensitive).
 * A 6-digit hex keeps `fallbackAlphaPct` — the opacity slider owns alpha, so
 * pasting a hue doesn't blow away the tint's translucency — while an explicit
 * 8-digit hex sets both.
 */
export function parseHexEntry(text: string, fallbackAlphaPct: number): ColorParts | null {
  const t = text.trim().toLowerCase();
  const hex = t.startsWith("#") ? t : `#${t}`;
  if (/^#[0-9a-f]{6}$/.test(hex)) return { hex, alphaPct: fallbackAlphaPct };
  const norm = normalizeHex8(hex);
  return norm === null ? null : splitHex8(norm);
}

/** The color a spec currently shows: its valid override, else its default. */
export function effectiveColor(
  overrides: Record<string, string>,
  spec: HighlightColorSpec,
  theme: Theme = DEFAULT_THEME,
): string {
  const raw = overrides[spec.key];
  return (raw === undefined ? null : normalizeHex8(raw)) ?? spec.defaultValues[theme];
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
  theme: Theme = DEFAULT_THEME,
): Record<string, string> {
  const next = { ...overrides };
  const norm = value === null ? null : normalizeHex8(value);
  if (norm === null || norm === spec.defaultValues[theme]) delete next[spec.key];
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
export function cssVarUpdates(
  overrides: Record<string, string>,
  theme: Theme = DEFAULT_THEME,
): CssVarUpdate[] {
  return HIGHLIGHT_COLORS.flatMap((spec) => {
    const raw = overrides[spec.key];
    const value = raw === undefined ? null : normalizeHex8(raw);
    const updates: CssVarUpdate[] = [
      { cssVar: spec.cssVar, value },
      {
        cssVar: spec.foregroundVar,
        value:
          value === null || theme === "dark" ? null : readableHighlightForeground(value, theme),
      },
    ];
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
export function applyHighlightColors(
  overrides: Record<string, string>,
  theme: Theme = currentTheme,
): void {
  const style = document.documentElement.style;
  for (const { cssVar, value } of cssVarUpdates(overrides, theme)) {
    if (value === null) style.removeProperty(cssVar);
    else style.setProperty(cssVar, value);
  }
}

function themeFromDocument(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

let currentTheme: Theme = themeFromDocument();
let currentPreference: ThemePreference = "system";
let currentOverrides: Record<string, string> = {};
let systemScheme: MediaQueryList | null = null;
const themeSubscribers = new Set<() => void>();

export function getTheme(): Theme {
  return currentTheme;
}

function subscribeTheme(listener: () => void): () => void {
  themeSubscribers.add(listener);
  return () => themeSubscribers.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);
}

function applyResolvedTheme(theme: Theme): void {
  const changed = currentTheme !== theme;
  currentTheme = theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = theme;
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    /* A cache miss only affects pre-render paint; durable settings remain authoritative. */
  }
  applyHighlightColors(currentOverrides, theme);
  if (changed) for (const listener of themeSubscribers) listener();
}

function handleSystemSchemeChange(event: MediaQueryListEvent): void {
  if (currentPreference === "system") applyResolvedTheme(event.matches ? "dark" : "light");
}

function stopSystemSchemeSync(): void {
  systemScheme?.removeEventListener("change", handleSystemSchemeChange);
  systemScheme = null;
}

function resolvePreference(preference: ThemePreference): Theme {
  if (preference !== "system") {
    stopSystemSchemeSync();
    return preference;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return themeFromDocument();
  }
  const next = window.matchMedia(SYSTEM_SCHEME_QUERY);
  if (next !== systemScheme) {
    stopSystemSchemeSync();
    systemScheme = next;
    systemScheme.addEventListener("change", handleSystemSchemeChange);
  }
  return next.matches ? "dark" : "light";
}

/** Apply the durable preference plus user highlight overrides to this window.
 *  Pre-paint hints cache the preference and its resolved two-state color; the
 *  next authoritative settings hydration always replaces both hints. */
export function applyAppearance(
  preference: ThemePreference,
  overrides: Record<string, string>,
): void {
  currentPreference = preference;
  currentOverrides = { ...overrides };
  try {
    localStorage.setItem(THEME_PREFERENCE_CACHE_KEY, preference);
  } catch {
    /* Like the resolved cache, this hint only improves the next pre-paint canvas. */
  }
  applyResolvedTheme(resolvePreference(preference));
}
