import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { collectCandidates, parseFilter, type ContentTerm, type ParsedFilter } from "./filter";
import { api, type FlowFilterRequest } from "./ipc";
import { toggledSet } from "./selection";
import type { FlowSummary, ResourceKind } from "./types";

type SetError = (value: string | null) => void;

export interface TrafficFilterSpec {
  id: string;
  query: string;
  kinds: readonly ResourceKind[];
  statuses: readonly string[];
  /** Saved/draft entries are real filters even when their conditions are empty. */
  emptyMatchesAll?: boolean;
}

export interface FilterMatch {
  /** Fail-open visibility verdict. Unscanned/failed candidates remain present. */
  matchedIds: Set<string> | null;
  /** Confirmed matches only, suitable for row tint and saved-filter counts. */
  confirmedIds: Set<string> | null;
  searching: boolean;
  failed: boolean;
}

export interface FilterMatchCollection {
  byId: ReadonlyMap<string, FilterMatch>;
  searching: boolean;
}

/** Backend scan verdicts. A failure is resolved for retry/coalescing purposes,
 * but remains visible and never becomes a confirmed tint/count match. */
export interface ScanState {
  scanned: Set<string>;
  matched: Set<string>;
  failed: Set<string>;
  versions: Map<string, number>;
}

export function emptyScan(): ScanState {
  return { scanned: new Set(), matched: new Set(), failed: new Set(), versions: new Map() };
}

export function mergeScan(
  prev: ScanState | null,
  scannedIds: string[],
  matchedIds: string[],
  failedIds: string[] = [],
): ScanState | null {
  if (prev === null) return null;
  return {
    scanned: new Set([...prev.scanned, ...scannedIds]),
    matched: new Set([...prev.matched, ...matchedIds]),
    failed: new Set([...prev.failed, ...failedIds]),
    versions: new Map([
      ...prev.versions,
      ...scannedIds.map((id) => [id, prev.versions.get(id) ?? 0] as const),
    ]),
  };
}

export function applyScanVerdicts(candidates: Set<string>, scan: ScanState): Set<string> {
  return new Set(
    [...candidates].filter(
      (id) => !scan.scanned.has(id) || scan.matched.has(id) || scan.failed.has(id),
    ),
  );
}

function specKey(spec: TrafficFilterSpec): string {
  return JSON.stringify([
    spec.id,
    spec.query,
    [...spec.kinds].sort(),
    [...spec.statuses].sort(),
    spec.emptyMatchesAll === true,
  ]);
}

interface CompiledSpec {
  id: string;
  key: string;
  hasFilter: boolean;
  parsed: ParsedFilter;
  kinds: Set<ResourceKind>;
  statuses: Set<string>;
}

interface MatchCompilationCache {
  signature: string;
  specs: CompiledSpec[];
  flowObjects: WeakMap<FlowSummary, number>;
  nextFlowVersion: MutableRefObject<number>;
}

function compileSpecs(specs: readonly TrafficFilterSpec[]): CompiledSpec[] {
  return specs.map((spec) => ({
    id: spec.id,
    key: specKey(spec),
    hasFilter:
      spec.emptyMatchesAll === true ||
      spec.query.trim() !== "" ||
      spec.kinds.length > 0 ||
      spec.statuses.length > 0,
    parsed: parseFilter(spec.query),
    kinds: new Set(spec.kinds),
    statuses: new Set(spec.statuses),
  }));
}

interface CompiledPlan {
  id: string;
  key: string;
  hasFilter: boolean;
  candidates: Set<string>;
  candidateIds: string[];
  candidateVersions: Map<string, number>;
  terms: ContentTerm[];
}

function compilePlans(
  flows: FlowSummary[],
  flowVersions: ReadonlyMap<string, number>,
  specs: readonly CompiledSpec[],
): CompiledPlan[] {
  return specs.map((spec) => {
    const candidates = collectCandidates(flows, spec.parsed, spec.kinds, spec.statuses);
    return {
      id: spec.id,
      key: spec.key,
      hasFilter: spec.hasFilter,
      candidates,
      candidateIds: [...candidates],
      candidateVersions: new Map(
        [...candidates].map((id) => [id, flowVersions.get(id) ?? 0] as const),
      ),
      terms: spec.parsed.contentTerms,
    };
  });
}

function pruneScans(
  plans: readonly CompiledPlan[],
  scans: ReadonlyMap<string, ScanState>,
): Map<string, ScanState> {
  const next = new Map<string, ScanState>();
  for (const plan of plans) {
    const scan = scans.get(plan.key);
    if (!scan) continue;
    const keep = plan.candidates;
    next.set(plan.key, {
      scanned: new Set([...scan.scanned].filter((id) => keep.has(id))),
      matched: new Set([...scan.matched].filter((id) => keep.has(id))),
      failed: new Set([...scan.failed].filter((id) => keep.has(id))),
      versions: new Map([...scan.versions].filter(([id]) => keep.has(id))),
    });
  }
  return next;
}

const MAX_BATCH_CANDIDATE_REFS = 512;

/** Build one fair, bounded IPC batch. Every active plan receives a slice before
 * spare capacity is assigned, so a huge saved filter cannot starve the bar or
 * draft preview behind it. */
export function buildFilterSearchBatch(
  plans: readonly Pick<CompiledPlan, "key" | "candidateIds" | "candidateVersions" | "terms">[],
  scans: ReadonlyMap<string, ScanState>,
  limit = MAX_BATCH_CANDIDATE_REFS,
): FlowFilterRequest[] {
  if (limit <= 0) return [];
  const pending = plans
    .filter((plan) => plan.terms.length > 0)
    .map((plan) => ({
      plan,
      ids: plan.candidateIds.filter(
        (id) => scans.get(plan.key)?.versions.get(id) !== plan.candidateVersions.get(id),
      ),
      completed: 0,
      used: 0,
    }))
    .filter(({ ids }) => ids.length > 0);
  if (pending.length === 0) return [];
  for (const item of pending) item.completed = item.plan.candidateIds.length - item.ids.length;
  pending.sort((a, b) => a.completed - b.completed);

  let remaining = limit;
  const quota = Math.max(1, Math.floor(limit / pending.length));
  for (const item of pending) {
    item.used = Math.min(item.ids.length, quota, remaining);
    remaining -= item.used;
  }
  for (const item of pending) {
    if (remaining === 0) break;
    const extra = Math.min(item.ids.length - item.used, remaining);
    item.used += extra;
    remaining -= extra;
  }
  return pending
    .filter(({ used }) => used > 0)
    .map(({ plan, ids, used }) => ({
      key: plan.key,
      candidates: ids.slice(0, used),
      terms: plan.terms,
    }));
}

function hasPending(plans: readonly CompiledPlan[], scans: ReadonlyMap<string, ScanState>) {
  return plans.some(
    (plan) =>
      plan.terms.length > 0 &&
      plan.candidateIds.some(
        (id) => scans.get(plan.key)?.versions.get(id) !== plan.candidateVersions.get(id),
      ),
  );
}

function mergeBatchVerdicts(
  previous: ScanState,
  candidateVersions: ReadonlyMap<string, number>,
  matchedIds: readonly string[],
  failed: boolean,
): ScanState {
  const scanned = new Set(previous.scanned);
  const matched = new Set(previous.matched);
  const failures = new Set(previous.failed);
  const versions = new Map(previous.versions);
  const hits = new Set(matchedIds);
  for (const [id, version] of candidateVersions) {
    scanned.add(id);
    versions.set(id, version);
    if (failed) {
      failures.add(id);
      matched.delete(id);
    } else {
      failures.delete(id);
      if (hits.has(id)) matched.add(id);
      else matched.delete(id);
    }
  }
  return { scanned, matched, failed: failures, versions };
}

function versionFlows(
  flows: FlowSummary[],
  objectVersions: WeakMap<FlowSummary, number>,
  nextVersion: MutableRefObject<number>,
): Map<string, number> {
  const versions = new Map<string, number>();
  for (const flow of flows) {
    let version = objectVersions.get(flow);
    if (version === undefined) {
      version = ++nextVersion.current;
      objectVersions.set(flow, version);
    }
    versions.set(flow.id, version);
  }
  return versions;
}

function dispatchedVersions(
  batch: FlowFilterRequest[],
  plans: readonly CompiledPlan[],
): Map<string, Map<string, number>> {
  const versions = new Map<string, Map<string, number>>();
  for (const request of batch) {
    const plan = plans.find((candidate) => candidate.key === request.key);
    versions.set(
      request.key,
      new Map(request.candidates.map((id) => [id, plan?.candidateVersions.get(id) ?? 0] as const)),
    );
  }
  return versions;
}

function mergeBatchIntoScans(
  scans: ReadonlyMap<string, ScanState>,
  plans: readonly CompiledPlan[],
  batch: FlowFilterRequest[],
  dispatched: ReadonlyMap<string, ReadonlyMap<string, number>>,
  latestRequestByPlan: ReadonlyMap<string, number>,
  requestSequence: number,
  matchedByKey: ReadonlyMap<string, readonly string[]> | null,
): Map<string, ScanState> {
  const next = new Map(scans);
  for (const request of batch) {
    if (latestRequestByPlan.get(request.key) !== requestSequence) continue;
    const latestPlan = plans.find((plan) => plan.key === request.key);
    const currentVersions = new Map(
      [...(dispatched.get(request.key) ?? [])].filter(
        ([id, version]) => latestPlan?.candidateVersions.get(id) === version,
      ),
    );
    const matched = matchedByKey?.get(request.key);
    next.set(
      request.key,
      mergeBatchVerdicts(
        next.get(request.key) ?? emptyScan(),
        currentVersions,
        matched ?? [],
        matched === undefined,
      ),
    );
  }
  return next;
}

interface FilterPumpContext {
  generation: MutableRefObject<number>;
  readyGeneration: MutableRefObject<number | null>;
  runningGeneration: MutableRefObject<number | null>;
  requestSequence: MutableRefObject<number>;
  latestRequestByPlan: MutableRefObject<Map<string, number>>;
  plans: MutableRefObject<CompiledPlan[]>;
  scans: MutableRefObject<Map<string, ScanState>>;
  setSearching: (searching: boolean) => void;
  renderScans: () => void;
  setError: SetError;
}

async function searchAndMergeBatch(
  generation: number,
  requestSequence: number,
  batch: FlowFilterRequest[],
  dispatched: ReadonlyMap<string, ReadonlyMap<string, number>>,
  context: FilterPumpContext,
): Promise<boolean> {
  let matchedByKey: ReadonlyMap<string, readonly string[]> | null;
  try {
    const result = await api.searchFlowFilters(batch);
    if (context.generation.current !== generation || result.cancelled) return false;
    matchedByKey = new Map(result.filters.map((filter) => [filter.key, filter.matched]));
  } catch (error) {
    if (context.generation.current !== generation) return false;
    context.setError(String(error));
    matchedByKey = null;
  }
  context.scans.current = mergeBatchIntoScans(
    context.scans.current,
    context.plans.current,
    batch,
    dispatched,
    context.latestRequestByPlan.current,
    requestSequence,
    matchedByKey,
  );
  context.renderScans();
  return true;
}

async function pumpFilterSearch(generation: number, context: FilterPumpContext): Promise<void> {
  if (
    context.generation.current !== generation ||
    context.readyGeneration.current !== generation ||
    context.runningGeneration.current === generation
  ) {
    return;
  }
  context.runningGeneration.current = generation;
  context.setSearching(true);
  try {
    while (context.generation.current === generation) {
      const batch = buildFilterSearchBatch(context.plans.current, context.scans.current);
      if (batch.length === 0) break;
      const requestSequence = ++context.requestSequence.current;
      for (const request of batch) {
        context.latestRequestByPlan.current.set(request.key, requestSequence);
      }
      const versions = dispatchedVersions(batch, context.plans.current);
      if (!(await searchAndMergeBatch(generation, requestSequence, batch, versions, context)))
        return;
    }
  } finally {
    if (context.runningGeneration.current === generation) {
      context.runningGeneration.current = null;
    }
    if (context.generation.current === generation) {
      context.setSearching(hasPending(context.plans.current, context.scans.current));
    }
  }
}

function presentMatches(
  plans: readonly CompiledPlan[],
  scans: ReadonlyMap<string, ScanState>,
): Map<string, FilterMatch> {
  const matches = new Map<string, FilterMatch>();
  for (const plan of plans) {
    if (!plan.hasFilter) {
      matches.set(plan.id, {
        matchedIds: null,
        confirmedIds: null,
        searching: false,
        failed: false,
      });
      continue;
    }
    if (plan.terms.length === 0) {
      matches.set(plan.id, {
        matchedIds: plan.candidates,
        confirmedIds: plan.candidates,
        searching: false,
        failed: false,
      });
      continue;
    }
    const scan = scans.get(plan.key) ?? emptyScan();
    const pending = (id: string) => scan.versions.get(id) !== plan.candidateVersions.get(id);
    matches.set(plan.id, {
      matchedIds: new Set(
        [...plan.candidates].filter(
          (id) => pending(id) || scan.matched.has(id) || scan.failed.has(id),
        ),
      ),
      confirmedIds: new Set(
        [...plan.candidates].filter((id) => !pending(id) && scan.matched.has(id)),
      ),
      searching: plan.candidateIds.some(pending),
      failed: plan.candidateIds.some((id) => !pending(id) && scan.failed.has(id)),
    });
  }
  return matches;
}

/** One central, cancellable matcher for the filter bar, saved filters, solo,
 * and the modeless builder draft. It never subscribes to flows: callers feed it
 * the main window's existing snapshots. */
export function useFilterMatches(
  flows: FlowSummary[],
  specs: readonly TrafficFilterSpec[],
  setError: SetError,
): FilterMatchCollection {
  const configSignature = JSON.stringify(specs.map(specKey));
  // Flow bodies/headers are immutable after their New/Completed event. The
  // main flow mirror replaces the summary object for every such event and a
  // resync rebuilds every object, even when visible fields happen to compare
  // equal. Object identity is therefore the content-revision signal without
  // adding body bytes or another subscription to FlowSummary.
  const compilationRef = useRef<MatchCompilationCache>({
    signature: "",
    specs: [],
    flowObjects: new WeakMap(),
    nextFlowVersion: { current: 0 },
  });
  if (compilationRef.current.signature !== configSignature) {
    compilationRef.current.signature = configSignature;
    compilationRef.current.specs = compileSpecs(specs);
  }
  const compilation = compilationRef.current;
  const plans = useMemo(
    () =>
      compilePlans(
        flows,
        versionFlows(flows, compilation.flowObjects, compilation.nextFlowVersion),
        compilation.specs,
      ),
    // The serialized signature makes referentially-new but value-identical
    // spec arrays cheap during hot flow batches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configSignature, flows],
  );
  const plansRef = useRef(plans);
  plansRef.current = plans;

  const scansRef = useRef<Map<string, ScanState>>(new Map());
  const [renderState, setRenderState] = useState({ scanVersion: 0, searching: false });
  const generationRef = useRef(0);
  const readyGenerationRef = useRef<number | null>(null);
  const runningGenerationRef = useRef<number | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestByPlanRef = useRef<Map<string, number>>(new Map());
  const pumpContext: FilterPumpContext = {
    generation: generationRef,
    readyGeneration: readyGenerationRef,
    runningGeneration: runningGenerationRef,
    requestSequence: requestSequenceRef,
    latestRequestByPlan: latestRequestByPlanRef,
    plans: plansRef,
    scans: scansRef,
    setSearching: (searching) => setRenderState((current) => ({ ...current, searching })),
    renderScans: () =>
      setRenderState((current) => ({ ...current, scanVersion: current.scanVersion + 1 })),
    setError,
  };

  // A semantic edit invalidates every prior verdict. Cancel immediately, then
  // debounce the replacement generation so typing does not flood the backend.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    readyGenerationRef.current = null;
    const retained = new Map<string, ScanState>();
    for (const plan of plansRef.current) {
      const scan = scansRef.current.get(plan.key);
      if (scan) retained.set(plan.key, scan);
    }
    scansRef.current = retained;
    const currentKeys = new Set(plansRef.current.map((plan) => plan.key));
    latestRequestByPlanRef.current = new Map(
      [...latestRequestByPlanRef.current].filter(([key]) => currentKeys.has(key)),
    );
    pumpContext.renderScans();
    pumpContext.setSearching(hasPending(plansRef.current, retained));
    void api.cancelFlowFilterSearch().catch(() => {});
    const timer = window.setTimeout(() => {
      if (generationRef.current !== generation) return;
      readyGenerationRef.current = generation;
      void pumpFilterSearch(generation, pumpContext);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSignature]);

  // New/completed flow snapshots extend existing generations incrementally.
  useEffect(() => {
    const generation = generationRef.current;
    scansRef.current = pruneScans(plansRef.current, scansRef.current);
    if (readyGenerationRef.current === generation) {
      void pumpFilterSearch(generation, pumpContext);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows]);

  useEffect(
    () => () => {
      generationRef.current++;
      void api.cancelFlowFilterSearch().catch(() => {});
    },
    [],
  );

  const byId = useMemo(
    () => presentMatches(plans, scansRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plans, renderState.scanVersion],
  );

  return { byId, searching: renderState.searching };
}

/** Filter-bar state only. Matching is centralized in `useSavedFilters`, where
 * it can share one backend batch with saved and draft filters. */
export function useTrafficFilter(_flows: FlowSummary[], _setError: SetError) {
  const [filter, setFilter] = useState("");
  const [typeChips, setTypeChips] = useState<Set<ResourceKind>>(new Set());
  const [statusChips, setStatusChips] = useState<Set<string>>(new Set());

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
    toggleTypeChip: (kind: ResourceKind) => setTypeChips((prev) => toggledSet(prev, kind)),
    toggleStatusChip: (status: string) => setStatusChips((prev) => toggledSet(prev, status)),
    resetFilter,
  };
}
