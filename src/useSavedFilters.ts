import { useEffect, useMemo, useState } from "react";

import { loadJson, loadString, persist } from "./localStore";
import {
  applyVisibility,
  combineMatches,
  DEFAULT_FILTER_OPACITY,
  nextFilterColor,
  normalizeFilterOpacity,
  sanitizeSavedFilters,
  savedFilterLabel,
  type FilterDraft,
  type FilterViewMode,
  type PreparedFilterDraft,
  type RowTint,
  type RowTintPresentation,
  type SavedFilter,
} from "./savedFilters";
import { useFilterMatches, type FilterMatch, type TrafficFilterSpec } from "./useTrafficFilter";
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

interface DraftPreviewState {
  draft: FilterDraft;
  only: boolean;
}

function presentFilters(filters: SavedFilter[], preview: FilterColorPreview | null): SavedFilter[] {
  if (!preview || !filters.some((f) => f.id === preview.id)) return filters;
  return filters.map((f) =>
    f.id === preview.id ? { ...f, color: preview.color, opacity: preview.opacity } : f,
  );
}

function buildTintPresentations(filters: SavedFilter[]): Map<string, RowTintPresentation> {
  const presentations = new Map<string, RowTintPresentation>();
  for (const filter of filters) {
    if (!filter.highlight) continue;
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
  const presentations = useMemo(() => buildTintPresentations(presentedFilters), [presentedFilters]);

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

function buildMatchSpecs(
  bar: { query: string; kinds: readonly ResourceKind[]; statuses: readonly string[] },
  filters: SavedFilter[],
  draftPreview: DraftPreviewState | null,
): TrafficFilterSpec[] {
  const specs: TrafficFilterSpec[] = [
    { id: "bar", query: bar.query, kinds: bar.kinds, statuses: bar.statuses },
    ...filters.map((filter) => ({
      id: `saved:${filter.id}`,
      query: filter.query,
      kinds: filter.kinds,
      statuses: filter.statuses,
      emptyMatchesAll: true,
    })),
  ];
  if (draftPreview) {
    specs.push({
      id: "draft",
      query: draftPreview.draft.query,
      kinds: draftPreview.draft.kinds,
      statuses: draftPreview.draft.statuses,
      emptyMatchesAll: true,
    });
  }
  return specs;
}

function computeMarks(
  flows: FlowSummary[],
  filters: SavedFilter[],
  matches: ReadonlyMap<string, FilterMatch>,
  draftPreview: DraftPreviewState | null,
): { counts: Map<string, number | null>; tints: Map<string, RowTint> } {
  const counts = new Map<string, number | null>();
  const tints = new Map<string, RowTint>();
  for (const filter of filters) {
    const match = matches.get(`saved:${filter.id}`);
    counts.set(
      filter.id,
      match?.searching || match?.failed ? null : (match?.confirmedIds?.size ?? 0),
    );
  }
  for (const flow of flows) {
    const tint = tintForFlow(flow.id, filters, matches, draftPreview);
    if (tint) tints.set(flow.id, tint);
  }
  return { counts, tints };
}

function tintForFlow(
  flowId: string,
  filters: SavedFilter[],
  matches: ReadonlyMap<string, FilterMatch>,
  draftPreview: DraftPreviewState | null,
): RowTint | undefined {
  if (draftPreview?.draft.highlight && matches.get("draft")?.confirmedIds?.has(flowId)) {
    return {
      filterId: "draft",
      color: draftPreview.draft.color,
      opacity: draftPreview.draft.opacity,
      label: `${savedFilterLabel(draftPreview.draft)} (preview)`,
    };
  }
  const filter = filters.find(
    (candidate) =>
      candidate.highlight && matches.get(`saved:${candidate.id}`)?.confirmedIds?.has(flowId),
  );
  return filter
    ? {
        filterId: filter.id,
        color: filter.color,
        opacity: filter.opacity,
        label: savedFilterLabel(filter),
      }
    : undefined;
}

const EMPTY_MATCH: FilterMatch = {
  matchedIds: null,
  confirmedIds: null,
  searching: false,
  failed: false,
};

function useMatchedFilterView(
  flows: FlowSummary[],
  bar: { query: string; kinds: readonly ResourceKind[]; statuses: readonly string[] },
  filters: SavedFilter[],
  solo: SavedFilter | null,
  draftPreview: DraftPreviewState | null,
  viewMode: FilterViewMode,
  setError: SetError,
) {
  const barKindsKey = bar.kinds.join(" ");
  const barStatusesKey = bar.statuses.join(" ");
  const specs = useMemo<TrafficFilterSpec[]>(
    () => buildMatchSpecs(bar, filters, draftPreview),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bar.query, barKindsKey, barStatusesKey, filters, draftPreview],
  );
  const matches = useFilterMatches(flows, specs, setError);
  const barMatch = matches.byId.get("bar") ?? EMPTY_MATCH;
  const soloMatch = solo ? matches.byId.get(`saved:${solo.id}`) : undefined;
  const draftMatch = draftPreview ? matches.byId.get("draft") : undefined;
  const effectiveSolo = draftPreview?.only ? draftMatch?.matchedIds : soloMatch?.matchedIds;
  const view = useMemo(
    () => applyVisibility(flows, viewMode, barMatch.matchedIds, effectiveSolo ?? null),
    [flows, viewMode, barMatch.matchedIds, effectiveSolo],
  );
  const combinedMatchedIds = useMemo(
    () => combineMatches(barMatch.matchedIds, effectiveSolo ?? null),
    [barMatch.matchedIds, effectiveSolo],
  );
  const marks = useMemo(
    () => computeMarks(flows, filters, matches.byId, draftPreview),
    [draftPreview, filters, flows, matches.byId],
  );
  return { barMatch, soloMatch, matches, view, combinedMatchedIds, marks };
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
  bar: { query: string; kinds: readonly ResourceKind[]; statuses: readonly string[] },
  setError: SetError,
) {
  const [filters, setFilters] = useState<SavedFilter[]>(() =>
    sanitizeSavedFilters(loadJson(FILTERS_KEY)),
  );
  const [soloId, setSoloId] = useState<string | null>(null);
  const [draftPreview, setDraftPreview] = useState<DraftPreviewState | null>(null);
  const { viewMode, setViewMode } = usePersistentViewMode();

  // Debounced persistence: the panel's editor updates `filters` per keystroke,
  // and per-key synchronous localStorage writes would ride the hot render path.
  useEffect(() => {
    const handle = window.setTimeout(() => persist(FILTERS_KEY, JSON.stringify(filters)), 300);
    return () => clearTimeout(handle);
  }, [filters]);

  const solo = filters.find((f) => f.id === soloId) ?? null;
  const matchedView = useMatchedFilterView(
    flows,
    bar,
    filters,
    solo,
    draftPreview,
    viewMode,
    setError,
  );
  const colorPresentation = useFilterColorPresentation(filters);
  const presentedSolo = solo ? (colorPresentation.byId.get(solo.id) ?? solo) : null;
  const presentedTints = useMemo(() => {
    const presentations = new Map(colorPresentation.tintPresentations);
    if (draftPreview?.draft.highlight) {
      presentations.set("draft", {
        color: draftPreview.draft.color,
        opacity: draftPreview.draft.opacity,
        label: `${savedFilterLabel(draftPreview.draft)} (preview)`,
      });
    }
    return presentations;
  }, [colorPresentation.tintPresentations, draftPreview]);

  function addFilter(
    query: string,
    kinds: ResourceKind[],
    statuses: string[],
    options?: Pick<PreparedFilterDraft, "color" | "opacity" | "highlight">,
  ): SavedFilter {
    const created: SavedFilter = {
      id: crypto.randomUUID(),
      query: query.trim(),
      kinds: [...kinds],
      statuses: [...statuses],
      color: options?.color ?? nextFilterColor(filters),
      opacity: options?.opacity ?? DEFAULT_FILTER_OPACITY,
      highlight: options?.highlight ?? true,
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
    tints: matchedView.marks.tints,
    tintPresentations: presentedTints,
    counts: matchedView.marks.counts,
    barMatchedIds: matchedView.barMatch.matchedIds,
    searching: matchedView.matches.searching,
    soloSearching: matchedView.soloMatch?.searching ?? false,
    combinedMatchedIds: matchedView.combinedMatchedIds,
    visibleFlows: matchedView.view.visible,
    listMatchedIds: matchedView.view.listMatched,
    addFilter,
    setDraftPreview,
    clearDraftPreview: () => setDraftPreview(null),
    previewFilterColor: colorPresentation.previewFilterColor,
    cancelFilterColorPreview: colorPresentation.cancelFilterColorPreview,
    updateFilter,
    removeFilter,
  };
}
