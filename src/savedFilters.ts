import { uniqBy } from "es-toolkit";

import type { FlowSummary, ResourceKind } from "./types";
import { KIND_CHIPS, matchesFilter, parseFilter, STATUS_CHIPS, type ParsedFilter } from "./filter";

// ---- the saved-filter list (issue #90) ----
//
// A saved filter freezes the whole filter state — the typed query PLUS the
// kind/status chips — under a user-assigned color. Each entry can tint its
// matching rows ("highlight") and at most one entry at a time can narrow the
// list to its matches alone ("only", held as `soloId` next to the list so the
// exclusivity is structural, not a per-entry flag to keep consistent).

export type FilterViewMode = "hide" | "dim";

export interface SavedFilter {
  id: string;
  query: string;
  kinds: ResourceKind[];
  statuses: string[];
  color: string;
  highlight: boolean;
}

export interface RowTint {
  color: string;
  label: string;
}

/** Distinct hues that read against the dark rows and stay clear of the
 *  status/accent/imported tokens. New filters take the first unused one. */
export const FILTER_COLORS = [
  "#e879f9",
  "#fbbf24",
  "#38bdf8",
  "#a3e635",
  "#fb7185",
  "#818cf8",
  "#fb923c",
  "#34d399",
] as const;

export function nextFilterColor(existing: SavedFilter[]): string {
  const used = new Set(existing.map((f) => f.color.toLowerCase()));
  return (
    FILTER_COLORS.find((c) => !used.has(c)) ?? FILTER_COLORS[existing.length % FILTER_COLORS.length]
  );
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Human label for an entry: the query text plus the chip names, so a
 *  chips-only filter (e.g. just "xhr") still reads as something. */
export function savedFilterLabel(f: SavedFilter): string {
  const parts = [f.query.trim(), ...f.kinds, ...f.statuses].filter(Boolean);
  return parts.join(" ") || "(everything)";
}

/** body:/header: terms need a backend scan, so highlights (recomputed on every
 *  live batch) skip them; "only" honors them via the full search pipeline. */
export function hasContentTerms(query: string): boolean {
  return parseFilter(query).contentTerms.length > 0;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(KIND_CHIPS.map((c) => c.kind));
const KNOWN_STATUSES: ReadonlySet<string> = new Set(STATUS_CHIPS);

/** Keep only chip values the UI can actually render and toggle — an unknown
 *  value from a hand edit or version skew would otherwise load as an invisible
 *  match-nothing constraint the editor can't even clear. */
function knownValues<T extends string>(v: unknown, known: ReadonlySet<string>): T[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is T => typeof x === "string" && known.has(x));
}

function sanitizeOne(raw: unknown): SavedFilter | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return null;
  if (typeof o.query !== "string") return null;
  return {
    id: o.id,
    query: o.query,
    kinds: knownValues<ResourceKind>(o.kinds, KNOWN_KINDS),
    statuses: knownValues<string>(o.statuses, KNOWN_STATUSES),
    color: typeof o.color === "string" && HEX_COLOR.test(o.color) ? o.color : FILTER_COLORS[0],
    highlight: o.highlight !== false,
  };
}

/** Parse a persisted saved-filter list, dropping entries a hand-edit or an
 *  older schema left malformed (tolerant like the other localStorage loaders). */
export function sanitizeSavedFilters(raw: unknown): SavedFilter[] {
  if (!Array.isArray(raw)) return [];
  return uniqBy(
    raw.map(sanitizeOne).filter((f): f is SavedFilter => f !== null),
    (f) => f.id,
  );
}

export interface FilterMatches {
  /** flow id → the first (list-order) highlighting filter that matches it. */
  tints: Map<string, RowTint>;
  /** filter id → matching-row count; null when the filter has content terms
   *  (a frontend count would silently ignore them, so show none instead). */
  counts: Map<string, number | null>;
}

export interface CompiledFilter {
  f: SavedFilter;
  parsed: ParsedFilter;
  kinds: Set<ResourceKind>;
  statuses: Set<string>;
  label: string;
}

/** Pre-parse the frontend-matchable filters once per list edit — matching
 *  reruns on every ~60ms flow batch and must not re-build regexes each time. */
export function compileFilters(filters: SavedFilter[]): CompiledFilter[] {
  return filters
    .filter((f) => !hasContentTerms(f.query))
    .map((f) => ({
      f,
      parsed: parseFilter(f.query),
      kinds: new Set(f.kinds),
      statuses: new Set(f.statuses),
      label: savedFilterLabel(f),
    }));
}

export function computeFilterMatches(
  flows: FlowSummary[],
  filters: SavedFilter[],
  compiled: CompiledFilter[],
): FilterMatches {
  const counts = new Map<string, number | null>(filters.map((f) => [f.id, null]));
  for (const c of compiled) counts.set(c.f.id, 0);
  const tints = new Map<string, RowTint>();
  if (compiled.length === 0) return { tints, counts };
  for (const s of flows) {
    for (const c of compiled) {
      if (!matchesFilter(s, c.parsed, c.kinds, c.statuses)) continue;
      counts.set(c.f.id, (counts.get(c.f.id) ?? 0) + 1);
      if (c.f.highlight && !tints.has(s.id)) {
        tints.set(s.id, { color: c.f.color, label: c.label });
      }
    }
  }
  return { tints, counts };
}

/** Intersect two optional match sets; null means "no filter active" on that
 *  side, so the other side passes through untouched. */
export function combineMatches(a: Set<string> | null, b: Set<string> | null): Set<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((id) => b.has(id)));
}

export interface VisibleView {
  visible: FlowSummary[];
  /** What TrafficList should dim against: the bar matches in dim mode, null in
   *  hide mode (every surviving row matches, so tint/dim/rail would be noise). */
  listMatched: Set<string> | null;
}

/** Resolve what the traffic list shows. "Only" (solo) always narrows the list —
 *  that's its meaning — while the bar filter narrows or dims per the view mode. */
export function applyVisibility(
  flows: FlowSummary[],
  mode: FilterViewMode,
  barMatched: Set<string> | null,
  soloMatched: Set<string> | null,
): VisibleView {
  if (mode === "hide") {
    const combined = combineMatches(barMatched, soloMatched);
    return {
      visible: combined ? flows.filter((f) => combined.has(f.id)) : flows,
      listMatched: null,
    };
  }
  return {
    visible: soloMatched ? flows.filter((f) => soloMatched.has(f.id)) : flows,
    listMatched: barMatched,
  };
}
