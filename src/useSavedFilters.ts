import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { loadJson, loadString, persist } from "./localStore";
import {
  applyVisibility,
  combineMatches,
  compileFilters,
  computeFilterMatches,
  DEFAULT_FILTER_OPACITY,
  hasContentTerms,
  nextFilterColor,
  normalizeFilterOpacity,
  sanitizeSavedFilters,
  savedFilterLabel,
  type FilterViewMode,
  type RowTintPresentation,
  type SavedFilter,
} from "./savedFilters";
import { useFilterMatch } from "./useTrafficFilter";
import type { ColorParts } from "./theme";
import type { FlowSummary, ResourceKind } from "./types";

const FILTERS_KEY = "germi.savedFilters";
const MODE_KEY = "germi.filterMode";

type SetError = (value: string | null) => void;

interface FilterColorPreview {
  id: string;
  color: string;
  opacity: number;
}

function presentFilters(filters: SavedFilter[], preview: FilterColorPreview | null): SavedFilter[] {
  if (!preview || !filters.some((f) => f.id === preview.id)) return filters;
  return filters.map((f) =>
    f.id === preview.id ? { ...f, color: preview.color, opacity: preview.opacity } : f,
  );
}

function tintPresentations(filters: SavedFilter[]): Map<string, RowTintPresentation> {
  const presentations = new Map<string, RowTintPresentation>();
  for (const filter of filters) {
    if (!filter.highlight || hasContentTerms(filter.query)) continue;
    presentations.set(filter.id, {
      color: filter.color,
      opacity: filter.opacity,
      label: savedFilterLabel(filter),
    });
  }
  return presentations;
}

function useFilterColorPresentation(filters: SavedFilter[]) {
  // One explicit, ephemeral presentation overlay. Picker drafts never enter
  // `filters`, so they cannot trigger matching or persistence.
  const [preview, setPreview] = useState<FilterColorPreview | null>(null);
  const presentedFilters = useMemo(() => presentFilters(filters, preview), [filters, preview]);
  const presentedById = useMemo(
    () => new Map(presentedFilters.map((f) => [f.id, f])),
    [presentedFilters],
  );
  const presentations = useMemo(() => tintPresentations(presentedFilters), [presentedFilters]);

  function previewFilterColor(id: string, value: ColorParts) {
    setPreview(
      filters.some((f) => f.id === id)
        ? { id, color: value.hex, opacity: normalizeFilterOpacity(value.alphaPct) }
        : null,
    );
  }

  function cancelFilterColorPreview(id: string) {
    setPreview((current) => (current?.id === id ? null : current));
  }

  return {
    filters: presentedFilters,
    byId: presentedById,
    tintPresentations: presentations,
    previewFilterColor,
    cancelFilterColorPreview,
    clear: () => setPreview(null),
  };
}

/** The solo'd ("only") filter fed through the full match pipeline, so its
 *  body:/header:/cookie: terms hit the backend scan like the bar filter's do. The chip
 *  sets are keyed by content, not entry identity, so editing an unrelated field
 *  (color, highlight) doesn't refire the content-search effect. */
function useSoloMatch(flows: FlowSummary[], solo: SavedFilter | null, setError: SetError) {
  const kindsKey = (solo?.kinds ?? []).join(" ");
  const statusesKey = (solo?.statuses ?? []).join(" ");
  const kinds = useMemo(
    () => new Set<ResourceKind>(solo?.kinds ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kindsKey],
  );
  const statuses = useMemo(
    () => new Set(solo?.statuses ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusesKey],
  );
  const match = useFilterMatch(flows, solo?.query ?? "", kinds, statuses, setError);
  return {
    matchedIds: solo ? match.matchedIds : null,
    searching: solo ? match.searching : false,
  };
}

function usePersistentViewMode() {
  const [viewMode, setViewModeState] = useState<FilterViewMode>(() =>
    loadString(MODE_KEY, ["hide", "dim"] as const, "hide"),
  );
  function setViewMode(mode: FilterViewMode) {
    setViewModeState(mode);
    persist(MODE_KEY, mode);
  }
  return { viewMode, setViewMode };
}

/**
 * The saved-filter list + the traffic-list view it produces (issue #90):
 * persistent colored filters that tint their matching rows, an exclusive
 * "only" (solo) filter narrowing the list through the full match pipeline,
 * and the hide/dim view mode deciding what the bar filter does to
 * non-matching rows.
 */
export function useSavedFilters(
  flows: FlowSummary[],
  barMatchedIds: Set<string> | null,
  setError: SetError,
) {
  const [filters, setFilters] = useState<SavedFilter[]>(() =>
    sanitizeSavedFilters(loadJson(FILTERS_KEY)),
  );
  const [soloId, setSoloId] = useState<string | null>(null);
  const { viewMode, setViewMode } = usePersistentViewMode();

  // Debounced persistence: the panel's editor updates `filters` per keystroke,
  // and per-key synchronous localStorage writes would ride the hot render path.
  useEffect(() => {
    const handle = window.setTimeout(() => persist(FILTERS_KEY, JSON.stringify(filters)), 300);
    return () => clearTimeout(handle);
  }, [filters]);

  const solo = filters.find((f) => f.id === soloId) ?? null;
  const soloMatch = useSoloMatch(flows, solo, setError);

  // Deferred like the bar query: a keystroke in the panel's editor must not
  // synchronously re-match every flow before the input echoes.
  const deferredFilters = useDeferredValue(filters);
  const compiled = useMemo(() => compileFilters(deferredFilters), [deferredFilters]);
  const marks = useMemo(
    () => computeFilterMatches(flows, deferredFilters, compiled),
    [flows, deferredFilters, compiled],
  );
  // Matching stays deferred and committed-state-only, while tint presentation
  // follows the current committed/preview color immediately. The filter id on
  // each mark preserves first-match precedence when filters overlap.
  const colorPresentation = useFilterColorPresentation(filters);
  const combinedMatchedIds = useMemo(
    () => combineMatches(barMatchedIds, soloMatch.matchedIds),
    [barMatchedIds, soloMatch.matchedIds],
  );
  const view = useMemo(
    () => applyVisibility(flows, viewMode, barMatchedIds, soloMatch.matchedIds),
    [flows, viewMode, barMatchedIds, soloMatch.matchedIds],
  );
  const presentedSolo = solo ? (colorPresentation.byId.get(solo.id) ?? solo) : null;

  function addFilter(query: string, kinds: ResourceKind[], statuses: string[]): SavedFilter {
    const created: SavedFilter = {
      id: crypto.randomUUID(),
      query: query.trim(),
      kinds,
      statuses,
      color: nextFilterColor(filters),
      opacity: DEFAULT_FILTER_OPACITY,
      highlight: true,
    };
    colorPresentation.clear();
    setFilters((prev) => [...prev, created]);
    return created;
  }

  function updateFilter(id: string, patch: Partial<Omit<SavedFilter, "id">>) {
    const normalized =
      patch.opacity === undefined
        ? patch
        : { ...patch, opacity: normalizeFilterOpacity(patch.opacity) };
    colorPresentation.clear();
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, ...normalized } : f)));
  }

  function removeFilter(id: string) {
    colorPresentation.clear();
    setFilters((prev) => prev.filter((f) => f.id !== id));
    setSoloId((prev) => (prev === id ? null : prev));
  }

  return {
    filters: colorPresentation.filters,
    soloId,
    setSolo: setSoloId,
    clearSolo: () => setSoloId(null),
    /** The chips-row "only: …" chip payload, or null when nothing is solo'd. */
    soloChip: presentedSolo
      ? {
          label: savedFilterLabel(presentedSolo),
          color: presentedSolo.color,
          opacity: presentedSolo.opacity,
        }
      : null,
    viewMode,
    setViewMode,
    toggleViewMode: () => setViewMode(viewMode === "hide" ? "dim" : "hide"),
    tints: marks.tints,
    tintPresentations: colorPresentation.tintPresentations,
    counts: marks.counts,
    soloSearching: soloMatch.searching,
    combinedMatchedIds,
    visibleFlows: view.visible,
    listMatchedIds: view.listMatched,
    addFilter,
    previewFilterColor: colorPresentation.previewFilterColor,
    cancelFilterColorPreview: colorPresentation.cancelFilterColorPreview,
    updateFilter,
    removeFilter,
  };
}
