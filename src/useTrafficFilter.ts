import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { difference, intersection } from "es-toolkit";

import { api } from "./ipc";
import { collectMatched, parseFilter, type ContentTerm } from "./filter";
import { toggledSet } from "./selection";
import type { FlowSummary, ResourceKind } from "./types";

type SetError = (value: string | null) => void;

async function runContentSearch(
  contentTerms: ContentTerm[],
  seedIds: string[],
  isCancelled: () => boolean,
): Promise<string[] | null> {
  let ids = seedIds;
  for (const ct of contentTerms) {
    const search = ct.field === "headers" ? api.searchHeaders : api.searchBodies;
    const result = await search(ct.value, ct.side, ct.regex, ids);
    if (isCancelled()) return null;
    ids = ct.neg ? difference(ids, result) : intersection(ids, result);
  }
  return ids;
}

/** Verdicts of the backend content scan: which flow ids have been scanned at
 *  all, and which of those matched. Flows outside `scanned` have no verdict
 *  yet and are treated as matching until one lands — a live capture must never
 *  silently hide a row the scan simply hasn't reached (issue #90 made hiding
 *  the default, so a stale scan would otherwise swallow new traffic). */
export interface ScanState {
  scanned: Set<string>;
  matched: Set<string>;
}

export function mergeScan(
  prev: ScanState | null,
  scannedIds: string[],
  matchedIds: string[],
): ScanState | null {
  if (prev === null) return null;
  return {
    scanned: new Set([...prev.scanned, ...scannedIds]),
    matched: new Set([...prev.matched, ...matchedIds]),
  };
}

export function applyScanVerdicts(summaryMatched: Set<string>, scan: ScanState): Set<string> {
  return new Set([...summaryMatched].filter((id) => !scan.scanned.has(id) || scan.matched.has(id)));
}

export interface FilterMatch {
  /** Ids passing the whole filter, or null when no filter is active. */
  matchedIds: Set<string> | null;
  /** True while a backend body/header scan is in flight. */
  searching: boolean;
}

/**
 * The full match pipeline for one filter (query + chip sets): instant summary
 * matching on the frontend plus the backend scan for body:/header: terms.
 * Shared by the filter bar and the solo'd saved filter (issue #90) —
 * `kinds`/`statuses` must be referentially stable while unchanged, or the
 * content-search effect refires on every render.
 *
 * The scan is incremental: a filter edit rescans everything (debounced), and
 * flows captured afterwards are scanned in serialized chunks so a long-lived
 * filter keeps converging instead of freezing at a point-in-time result.
 */
export function useFilterMatch(
  flows: FlowSummary[],
  query: string,
  kinds: Set<ResourceKind>,
  statuses: Set<string>,
  setError: SetError,
): FilterMatch {
  const [scan, setScan] = useState<ScanState | null>(null);
  const [searching, setSearching] = useState(false);
  const summaryMatchedRef = useRef<Set<string>>(new Set());
  const scanInFlightRef = useRef(false);
  // Bumped on every filter change so a scan started for the previous filter
  // can't merge its verdicts into the new one.
  const generationRef = useRef(0);

  const deferredQuery = useDeferredValue(query);
  const parsed = useMemo(() => parseFilter(deferredQuery), [deferredQuery]);

  const hasFilter = query.trim() !== "" || kinds.size > 0 || statuses.size > 0;

  const summaryMatched = useMemo(
    () => collectMatched(flows, parsed, kinds, statuses),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flows, deferredQuery, kinds, statuses],
  );
  summaryMatchedRef.current = summaryMatched;

  async function scanChunk(generation: number, seed: string[], reset: boolean) {
    scanInFlightRef.current = true;
    setSearching(true);
    try {
      const ids = await runContentSearch(
        parsed.contentTerms,
        seed,
        () => generationRef.current !== generation,
      );
      if (ids === null || generationRef.current !== generation) return;
      setScan((prev) =>
        reset ? { scanned: new Set(seed), matched: new Set(ids) } : mergeScan(prev, seed, ids),
      );
    } catch (e) {
      if (generationRef.current !== generation) return;
      setError(String(e));
      // Mark the chunk scanned-and-matched: the rows stay visible, and the
      // failing backend call isn't retried on every flow batch.
      setScan((prev) => (reset ? null : mergeScan(prev, seed, seed)));
    } finally {
      if (generationRef.current === generation) {
        scanInFlightRef.current = false;
        setSearching(false);
      }
    }
  }

  // Filter change: drop all verdicts and rescan everything (debounced).
  useEffect(() => {
    generationRef.current++;
    setScan(null);
    scanInFlightRef.current = false;
    if (parsed.contentTerms.length === 0) {
      setSearching(false);
      return;
    }
    const generation = generationRef.current;
    setSearching(true);
    const handle = window.setTimeout(() => {
      void scanChunk(generation, [...summaryMatchedRef.current], true);
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, kinds, statuses]);

  // Flows captured after the last scan: scan just those, one chunk at a time
  // (a completing chunk updates `scan`, which re-runs this to pick up the next).
  useEffect(() => {
    if (parsed.contentTerms.length === 0 || scan === null || scanInFlightRef.current) return;
    const pending = [...summaryMatched].filter((id) => !scan.scanned.has(id));
    if (pending.length === 0) return;
    void scanChunk(generationRef.current, pending, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryMatched, scan]);

  const matchedIds = useMemo(() => {
    if (!hasFilter) return null;
    if (parsed.contentTerms.length === 0 || scan === null) return summaryMatched;
    return applyScanVerdicts(summaryMatched, scan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFilter, summaryMatched, scan, deferredQuery]);

  return { matchedIds, searching };
}

/** The filter bar's state (typed query + kind/status chips) fed through the
 *  match pipeline. */
export function useTrafficFilter(flows: FlowSummary[], setError: SetError) {
  const [filter, setFilter] = useState("");
  const [typeChips, setTypeChips] = useState<Set<ResourceKind>>(new Set());
  const [statusChips, setStatusChips] = useState<Set<string>>(new Set());
  const { matchedIds, searching } = useFilterMatch(flows, filter, typeChips, statusChips, setError);

  function resetFilter() {
    setFilter("");
    setTypeChips(new Set());
    setStatusChips(new Set());
  }

  return {
    filter,
    setFilter,
    typeChips,
    statusChips,
    toggleTypeChip: (k: ResourceKind) => setTypeChips((prev) => toggledSet(prev, k)),
    toggleStatusChip: (c: string) => setStatusChips((prev) => toggledSet(prev, c)),
    resetFilter,
    matchedIds,
    searching,
  };
}
