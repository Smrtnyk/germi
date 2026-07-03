import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { loadJson, loadString, persist } from "./localStore";
import {
  applyVisibility,
  combineMatches,
  compileFilters,
  computeFilterMatches,
  nextFilterColor,
  sanitizeSavedFilters,
  savedFilterLabel,
  type FilterViewMode,
  type SavedFilter,
} from "./savedFilters";
import { useFilterMatch } from "./useTrafficFilter";
import type { FlowSummary, ResourceKind } from "./types";

const FILTERS_KEY = "germi.savedFilters";
const MODE_KEY = "germi.filterMode";

type SetError = (value: string | null) => void;

/** The solo'd ("only") filter fed through the full match pipeline, so its
 *  body:/header: terms hit the backend scan like the bar filter's do. The chip
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
  const combinedMatchedIds = useMemo(
    () => combineMatches(barMatchedIds, soloMatch.matchedIds),
    [barMatchedIds, soloMatch.matchedIds],
  );
  const view = useMemo(
    () => applyVisibility(flows, viewMode, barMatchedIds, soloMatch.matchedIds),
    [flows, viewMode, barMatchedIds, soloMatch.matchedIds],
  );

  function addFilter(query: string, kinds: ResourceKind[], statuses: string[]): SavedFilter {
    const created: SavedFilter = {
      id: crypto.randomUUID(),
      query: query.trim(),
      kinds,
      statuses,
      color: nextFilterColor(filters),
      highlight: true,
    };
    setFilters((prev) => [...prev, created]);
    return created;
  }

  function updateFilter(id: string, patch: Partial<Omit<SavedFilter, "id">>) {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function removeFilter(id: string) {
    setFilters((prev) => prev.filter((f) => f.id !== id));
    setSoloId((prev) => (prev === id ? null : prev));
  }

  return {
    filters,
    soloId,
    setSolo: setSoloId,
    clearSolo: () => setSoloId(null),
    /** The chips-row "only: …" chip payload, or null when nothing is solo'd. */
    soloChip: solo ? { label: savedFilterLabel(solo), color: solo.color } : null,
    viewMode,
    setViewMode,
    toggleViewMode: () => setViewMode(viewMode === "hide" ? "dim" : "hide"),
    tints: marks.tints,
    counts: marks.counts,
    soloSearching: soloMatch.searching,
    combinedMatchedIds,
    visibleFlows: view.visible,
    listMatchedIds: view.listMatched,
    addFilter,
    updateFilter,
    removeFilter,
  };
}
