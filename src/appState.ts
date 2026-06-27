import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";

import { announce } from "./announce";
import { api, subscribeFlows } from "./ipc";
import { parseFilter, statusClass, type BodyTerm, type ParsedFilter } from "./filter";
import { resolveColumns, DEFAULT_COLUMNS } from "./columns";
import { useSplitRatio } from "./useResizable";
import { useProxyIndicator } from "./useProxyIndicator";
import { useSystemHotkeys } from "./useSystemHotkeys";
import { useToasts, type Notify } from "./toast";
import { toCurl } from "./curl";
import { flowUrl } from "./flowUrl";
import { focusMockResponseBody } from "./focusMockBody";
import { nextIdAfterDelete, toggleSelection } from "./selection";
import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  insertRuleSummaryAfter,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
} from "./autoresponderState";
import type {
  AutoResponderSummary,
  AvailabilityProgress,
  BulkMockEvent,
  CaInfo,
  FlowDetail,
  FlowEvent,
  FlowSummary,
  HistoryTag,
  ProxySettings,
  ResourceKind,
  Rule,
  RuleSummary,
  ScenarioSummary,
} from "./types";

export type RightTab = "inspector" | "autoresponder";
export type RightMode = "single" | "split";

type SetError = (value: string | null) => void;

function loadString<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function pruneFlows(map: Map<string, FlowSummary>, order: string[], ids: string[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  for (const id of gone) map.delete(id);
  let w = 0;
  for (let r = 0; r < order.length; r++) {
    if (!gone.has(order[r])) order[w++] = order[r];
  }
  order.length = w;
}

function applyFlowEvents(
  map: Map<string, FlowSummary>,
  order: string[],
  events: FlowEvent[],
  cap: number,
): boolean {
  let resync = false;
  for (const ev of events) {
    if (ev.type === "cleared") {
      map.clear();
      order.length = 0;
      continue;
    }
    if (ev.type === "removed") {
      pruneFlows(map, order, ev.ids);
      continue;
    }
    if (ev.type === "resync") {
      resync = true;
      continue;
    }
    const s = ev.summary;
    if (!map.has(s.id)) order.push(s.id);
    map.set(s.id, s);
  }
  if (order.length > cap) {
    const removed = order.splice(0, order.length - cap);
    for (const id of removed) map.delete(id);
  }
  return resync;
}

async function reconcileFlows(
  map: Map<string, FlowSummary>,
  order: string[],
  bump: () => void,
  setError: SetError,
): Promise<void> {
  const knownBefore = new Set(order);
  try {
    const fresh = await api.listFlows();
    const freshIds = new Set(fresh.map((s) => s.id));
    for (const s of fresh) {
      if (!map.has(s.id)) order.push(s.id);
      map.set(s.id, s);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (knownBefore.has(id) && !freshIds.has(id)) {
        order.splice(i, 1);
        map.delete(id);
      }
    }
    bump();
  } catch (e) {
    setError(String(e));
  }
}

function collectFlows(order: string[], map: Map<string, FlowSummary>): FlowSummary[] {
  const arr: FlowSummary[] = [];
  for (const id of order) {
    const s = map.get(id);
    if (s) arr.push(s);
  }
  return arr;
}

function mergeFlows(order: string[], map: Map<string, FlowSummary>, list: FlowSummary[]): void {
  for (const s of list) {
    if (!map.has(s.id)) order.push(s.id);
    map.set(s.id, s);
  }
}

function toggledSet<T>(prev: Set<T>, item: T): Set<T> {
  const next = new Set(prev);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

function rangeSelection(ids: string[], anchor: string, id: string): Set<string> | null {
  const a = ids.indexOf(anchor);
  const b = ids.indexOf(id);
  if (a === -1 || b === -1) return null;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(ids.slice(lo, hi + 1));
}

function matchesFilter(
  s: FlowSummary,
  parsed: ParsedFilter,
  typeChips: Set<ResourceKind>,
  statusChips: Set<string>,
): boolean {
  if (typeChips.size && !typeChips.has(s.kind)) return false;
  if (statusChips.size && !statusChips.has(statusClass(s.status))) return false;
  return parsed.matchSummary(s);
}

function collectMatched(
  flows: FlowSummary[],
  parsed: ParsedFilter,
  typeChips: Set<ResourceKind>,
  statusChips: Set<string>,
): Set<string> {
  const set = new Set<string>();
  for (const s of flows) {
    if (matchesFilter(s, parsed, typeChips, statusChips)) set.add(s.id);
  }
  return set;
}

async function runBodySearch(
  bodyTerms: BodyTerm[],
  seedIds: string[],
  isCancelled: () => boolean,
): Promise<string[] | null> {
  let ids = seedIds;
  for (const bt of bodyTerms) {
    const result = await api.searchBodies(bt.value, bt.side, bt.regex, ids);
    if (isCancelled()) return null;
    const hit = new Set(result);
    ids = ids.filter((id) => (bt.neg ? !hit.has(id) : hit.has(id)));
  }
  return ids;
}

async function performBodySearch(
  bodyTerms: BodyTerm[],
  seedIds: string[],
  isCancelled: () => boolean,
  apply: (ids: Set<string>) => void,
  setSearching: (busy: boolean) => void,
  setError: SetError,
): Promise<void> {
  try {
    const ids = await runBodySearch(bodyTerms, seedIds, isCancelled);
    if (ids && !isCancelled()) apply(new Set(ids));
  } catch (e) {
    if (!isCancelled()) setError(String(e));
  } finally {
    if (!isCancelled()) setSearching(false);
  }
}

function intersectMatches(
  hasFilter: boolean,
  summaryMatched: Set<string>,
  bodyMatchIds: Set<string> | null,
  hasBodyTerms: boolean,
): Set<string> | null {
  if (!hasFilter) return null;
  if (!hasBodyTerms || bodyMatchIds === null) return summaryMatched;
  return new Set([...summaryMatched].filter((id) => bodyMatchIds.has(id)));
}

function loadColumnOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem("germi.columns") ?? "null");
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

function persistSettings(
  next: ProxySettings,
  prevHeaderColumns: string[],
  refresh: () => Promise<void>,
  setError: SetError,
): void {
  const headersChanged = JSON.stringify(next.headerColumns) !== JSON.stringify(prevHeaderColumns);
  void api
    .setSettings(next)
    .then(async () => {
      if (headersChanged) await refresh();
    })
    .catch((e) => setError(String(e)));
}

async function loadInitialState(opts: {
  setRunning: (running: boolean) => void;
  setAutoresponder: (ar: AutoResponderSummary) => void;
  setSettings: (s: ProxySettings) => void;
  setCaInfo: (ca: CaInfo) => void;
  loadInitialFlows: () => Promise<void>;
  setError: SetError;
}): Promise<void> {
  try {
    const isRunning = await api.proxyStatus();
    opts.setRunning(isRunning);
    opts.setAutoresponder(await api.getAutoresponderSummary());
    const loaded = await api.getSettings();
    opts.setSettings(loaded);
    opts.setCaInfo(await api.caInfo());
    await opts.loadInitialFlows();
    if (loaded.captureOnStart && !isRunning) {
      const boundPort = await api.startProxy(loaded.port, loaded.allowRemote);
      if (boundPort !== loaded.port) opts.setSettings({ ...loaded, port: boundPort });
      opts.setRunning(true);
    }
  } catch (e) {
    opts.setError(String(e));
  }
}

function useFlowStore(maxFlows: number, setError: SetError) {
  const flowsRef = useRef<Map<string, FlowSummary>>(new Map());
  const orderRef = useRef<string[]>([]);
  const maxFlowsRef = useRef(maxFlows);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    maxFlowsRef.current = maxFlows;
  }, [maxFlows]);

  useEffect(() => {
    const channel = subscribeFlows((events) => {
      const cap = Math.max(1, maxFlowsRef.current);
      const resync = applyFlowEvents(flowsRef.current, orderRef.current, events, cap);
      bump();
      if (resync) {
        void reconcileFlows(flowsRef.current, orderRef.current, bump, setError);
      }
    }, setError);
    return () => {
      channel.onmessage = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flows = useMemo(
    () => collectFlows(orderRef.current, flowsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  );

  function editComment(id: string, comment: string | null) {
    const s = flowsRef.current.get(id);
    if (s) {
      flowsRef.current.set(id, { ...s, comment });
      bump();
    }
    void api.setFlowComment(id, comment).catch((e) => setError(String(e)));
  }

  async function loadInitial() {
    mergeFlows(orderRef.current, flowsRef.current, await api.listFlows());
    bump();
  }

  async function refresh() {
    const fresh = await api.listFlows();
    for (const fs of fresh) flowsRef.current.set(fs.id, fs);
    bump();
  }

  return { flows, flowsRef, orderRef, tick, editComment, loadInitial, refresh };
}

function useTrafficFilter(flows: FlowSummary[], setError: SetError) {
  const [filter, setFilter] = useState("");
  const [typeChips, setTypeChips] = useState<Set<ResourceKind>>(new Set());
  const [statusChips, setStatusChips] = useState<Set<string>>(new Set());
  const [bodyMatchIds, setBodyMatchIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const summaryMatchedRef = useRef<Set<string>>(new Set());

  const deferredFilter = useDeferredValue(filter);
  const parsed = useMemo(() => parseFilter(deferredFilter), [deferredFilter]);

  const hasFilter = filter.trim() !== "" || typeChips.size > 0 || statusChips.size > 0;

  const summaryMatched = useMemo(
    () => collectMatched(flows, parsed, typeChips, statusChips),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flows, deferredFilter, typeChips, statusChips],
  );
  summaryMatchedRef.current = summaryMatched;

  useEffect(() => {
    if (parsed.bodyTerms.length === 0) {
      setBodyMatchIds(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(() => {
      void performBodySearch(
        parsed.bodyTerms,
        [...summaryMatchedRef.current],
        () => cancelled,
        setBodyMatchIds,
        setSearching,
        setError,
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFilter, typeChips, statusChips]);

  const matchedIds = useMemo(
    () => intersectMatches(hasFilter, summaryMatched, bodyMatchIds, parsed.bodyTerms.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFilter, summaryMatched, bodyMatchIds, deferredFilter],
  );

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

function useSelection(flows: FlowSummary[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  function extendOrSelect(id: string, extend: boolean) {
    if (extend && anchorRef.current) {
      const range = rangeSelection(
        flows.map((f) => f.id),
        anchorRef.current,
        id,
      );
      if (range) setSelectedIds(range);
      setSelectedId(id);
    } else {
      setSelectedIds(new Set([id]));
      setSelectedId(id);
      anchorRef.current = id;
    }
  }

  function onRowClick(id: string, e: ReactMouseEvent) {
    if (e.shiftKey && anchorRef.current) {
      extendOrSelect(id, true);
    } else if (e.ctrlKey || e.metaKey) {
      const patch = toggleSelection(
        flows.map((f) => f.id),
        selectedIds,
        selectedId,
        id,
      );
      setSelectedIds(patch.selectedIds);
      setSelectedId(patch.selectedId);
      anchorRef.current = patch.anchor;
    } else {
      extendOrSelect(id, false);
    }
  }

  function selectByKeyboard(id: string, extend: boolean) {
    extendOrSelect(id, extend);
  }

  function selectAll(ids: string[]) {
    if (ids.length === 0) return;
    setSelectedIds(new Set(ids));
    setSelectedId(ids[ids.length - 1]);
    anchorRef.current = ids[0];
  }

  function clearSelection() {
    setSelectedId(null);
    setSelectedIds(new Set());
  }

  function deselect(ids: string[]) {
    const gone = new Set(ids);
    setSelectedIds((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    setSelectedId((cur) => (cur !== null && gone.has(cur) ? null : cur));
  }

  return {
    selectedId,
    selectedIds,
    onRowClick,
    selectByKeyboard,
    selectAll,
    clearSelection,
    deselect,
  };
}

function useFlowDetail(
  selectedId: string | null,
  decode: boolean,
  fullBody: boolean,
  selectedSummary: FlowSummary | undefined,
) {
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  // Track what the showing detail is for, so a background re-fetch (status /
  // duration completing) doesn't blank the pane — only switching flows does.
  const shownIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLoading(false);
      shownIdRef.current = null;
      return;
    }
    if (shownIdRef.current !== selectedId) {
      setDetail(null);
      setLoading(true);
    }
    let active = true;
    void api
      .getFlow(selectedId, decode, fullBody)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setLoading(false);
        shownIdRef.current = selectedId;
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, decode, fullBody, selectedSummary?.status, selectedSummary?.durationMs]);

  return { detail, setDetail, loading };
}

function useProxyControl(
  settings: ProxySettings,
  setError: SetError,
  onPortBound: (port: number) => void,
  notify: Notify,
) {
  const [running, setRunning] = useState(false);
  const [systemProxy, setSystemProxy] = useState(false);
  const [busy, setBusy] = useState(false);

  async function startProxy(): Promise<number> {
    const boundPort = await api.startProxy(settings.port, settings.allowRemote);
    if (boundPort !== settings.port) onPortBound(boundPort);
    setRunning(true);
    notify(
      "success",
      `Proxy listening on ${settings.allowRemote ? "0.0.0.0" : "127.0.0.1"}:${boundPort}`,
    );
    return boundPort;
  }

  async function toggleProxy() {
    if (busy) return;
    setBusy(true);
    try {
      if (running) {
        if (systemProxy) {
          await api.clearSystemProxy().catch(() => {});
          setSystemProxy(false);
        }
        await api.stopProxy();
        setRunning(false);
      } else {
        await startProxy();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSystemProxyWith(report: (message: string) => void) {
    if (busy) return;
    setBusy(true);
    try {
      if (systemProxy) {
        await api.clearSystemProxy();
        setSystemProxy(false);
        report("System proxy off");
      } else {
        const port = running ? settings.port : await startProxy();
        await api.setSystemProxy(port);
        setSystemProxy(true);
        report("System proxy on — routed through Germi");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSystemProxy() {
    return toggleSystemProxyWith((m) => notify("info", m));
  }

  function toggleSystemProxyHotkey() {
    return toggleSystemProxyWith((m) => {
      void announce(notify, m);
    });
  }

  return {
    running,
    setRunning,
    systemProxy,
    busy,
    toggleProxy,
    toggleSystemProxy,
    toggleSystemProxyHotkey,
  };
}

function useSettings() {
  const [settings, setSettings] = useState<ProxySettings>({
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    captureOnStart: false,
    responseDelayMs: 0,
    systemProxyHotkey: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  return { settings, setSettings, settingsOpen, setSettingsOpen };
}

function useRuleHits(activeScenarioId: string | null, active: boolean, setError: SetError) {
  const [ruleHits, setRuleHits] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      void api.ruleHits().then((h) => {
        if (!cancelled) setRuleHits(h);
      });
    poll();
    const interval = active ? window.setInterval(poll, 1500) : null;
    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [activeScenarioId, active]);

  function resetRuleState(scenarioId: string | null) {
    void api
      .resetRuleState(scenarioId)
      .then(() => api.ruleHits())
      .then(setRuleHits)
      .catch((e) => setError(String(e)));
  }

  return { ruleHits, resetRuleState };
}

function scenarioNameIn(ar: AutoResponderSummary, id: string | null): string {
  return ar.scenarios.find((scenario) => scenario.id === id)?.name || "scenario";
}

function ruleNameIn(ar: AutoResponderSummary, ruleId: string): string {
  for (const scenario of ar.scenarios) {
    const found = scenario.rules.find((rule) => rule.id === ruleId);
    if (found) return found.name || "rule";
  }
  return "rule";
}

function activateLabel(ar: AutoResponderSummary, scenarioId: string | null): string {
  return scenarioId ? `Activate "${scenarioNameIn(ar, scenarioId)}"` : "Turn mocking off";
}

function useAutoresponder(
  setError: SetError,
  setRightTab: (tab: RightTab) => void,
  notify: Notify,
  autoresponderActive: boolean,
) {
  const [autoresponder, setAutoresponder] = useState<AutoResponderSummary>({
    scenarios: [],
    activeScenarioId: null,
  });
  const [selectRuleId, setSelectRuleId] = useState<string | null>(null);
  const [bulkMockProgress, setBulkMockProgress] = useState<BulkMockEvent | null>(null);
  const { ruleHits, resetRuleState } = useRuleHits(
    autoresponder.activeScenarioId,
    autoresponderActive,
    setError,
  );

  // Latest summary in a ref so actions can build human history labels (scenario
  // / rule names) without taking the summary as a dependency.
  const arRef = useRef(autoresponder);
  arRef.current = autoresponder;

  const refresh = useCallback(async () => {
    try {
      setAutoresponder(await api.getAutoresponderSummary());
    } catch (e) {
      setError(String(e));
    }
  }, [setError]);

  const activateScenario = useCallback(
    (scenarioId: string | null) => {
      setAutoresponder((current) => ({ ...current, activeScenarioId: scenarioId }));
      const label = activateLabel(arRef.current, scenarioId);
      void api.setActiveScenario(scenarioId, { label }).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setError],
  );

  const createScenario = useCallback(async (): Promise<ScenarioSummary | null> => {
    try {
      const scenario = await api.createScenario(null, { label: "New scenario" });
      setAutoresponder((current) => ({
        scenarios: [...current.scenarios, scenario],
        activeScenarioId: scenario.id,
      }));
      return scenario;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [setError]);

  const renameScenario = useCallback(
    (scenarioId: string, name: string) => {
      setAutoresponder((current) => ({
        ...current,
        scenarios: current.scenarios.map((scenario) =>
          scenario.id === scenarioId ? { ...scenario, name } : scenario,
        ),
      }));
      void api
        .renameScenario(scenarioId, name, {
          label: "Rename scenario",
          coalesceKey: `scenario:${scenarioId}:name`,
        })
        .catch((e) => {
          setError(String(e));
          void refresh();
        });
    },
    [refresh, setError],
  );

  const deleteScenario = useCallback(
    (scenarioId: string) => {
      const label = `Delete scenario "${scenarioNameIn(arRef.current, scenarioId)}"`;
      setAutoresponder((current) => ({
        scenarios: current.scenarios.filter((scenario) => scenario.id !== scenarioId),
        activeScenarioId: current.activeScenarioId === scenarioId ? null : current.activeScenarioId,
      }));
      void api.deleteScenario(scenarioId, { label }).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setError],
  );

  const createRule = useCallback(
    async (scenarioId: string): Promise<RuleSummary | null> => {
      try {
        const rule = await api.createRule(scenarioId, { label: "New rule" });
        setAutoresponder((current) => appendRuleSummary(current, scenarioId, rule));
        return rule;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setError],
  );

  const loadRule = useCallback(
    async (ruleId: string): Promise<Rule | null> => {
      try {
        return await api.getRule(ruleId);
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setError],
  );

  const updateRule = useCallback(
    async (scenarioId: string, rule: Rule, tag?: HistoryTag): Promise<RuleSummary | null> => {
      try {
        const summary = await api.updateRule(
          scenarioId,
          rule,
          tag ?? {
            label: `Edit rule "${rule.name || "untitled"}"`,
            coalesceKey: `rule:${rule.id}`,
          },
        );
        setAutoresponder((current) => replaceRuleSummary(current, scenarioId, summary));
        return summary;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setError],
  );

  const deleteRule = useCallback(
    (scenarioId: string, ruleId: string) => {
      const label = `Delete rule "${ruleNameIn(arRef.current, ruleId)}"`;
      setAutoresponder((current) => removeRuleSummary(current, scenarioId, ruleId));
      void api.deleteRule(scenarioId, ruleId, { label }).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setError],
  );

  const duplicateRule = useCallback(
    async (scenarioId: string, ruleId: string): Promise<RuleSummary | null> => {
      try {
        const copy = await api.duplicateRule(scenarioId, ruleId, { label: "Duplicate rule" });
        setAutoresponder((current) => insertRuleSummaryAfter(current, scenarioId, ruleId, copy));
        return copy;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setError],
  );

  const reorderRule = useCallback(
    (scenarioId: string, ruleId: string, toId: string) => {
      if (ruleId === toId) return;
      setAutoresponder((current) => reorderRuleSummary(current, scenarioId, ruleId, toId));
      void api.reorderRule(scenarioId, ruleId, toId, { label: "Reorder rules" }).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setError],
  );

  async function mockFlows(ids: string[], scenarioId: string | null): Promise<boolean> {
    setError(null);
    setBulkMockProgress({
      type: "progress",
      completed: 0,
      total: ids.length,
      phase: "generating",
    });
    try {
      const label = `Mock ${plural(ids.length, "flow")}`;
      const result = await api.mockFlows(ids, scenarioId, { label }, (event) => {
        if (event.type === "progress") {
          setBulkMockProgress(event);
          return;
        }
        setAutoresponder((current) =>
          appendBulkRuleSummaries(current, event.scenarioId, event.rules),
        );
      });
      setSelectRuleId(result.newRuleIds[0] ?? null);
      setRightTab("autoresponder");
      const n = result.newRuleIds.length;
      notify("success", n > 1 ? `Created ${plural(n, "mock rule")}` : "Mock rule created");
      window.setTimeout(() => setBulkMockProgress(null), 500);
      return true;
    } catch (e) {
      setBulkMockProgress(null);
      setError(String(e));
      return false;
    }
  }

  async function exportRules(scenarioId: string | null) {
    try {
      const ok = await api.exportRules(scenarioId);
      if (ok) notify("success", scenarioId ? "Scenario exported" : "All scenarios exported");
    } catch (e) {
      setError(String(e));
    }
  }

  async function importRules(replace: boolean) {
    try {
      const n = await api.importRules(replace, {
        label: replace ? "Replace rules (import)" : "Import rules",
      });
      if (n > 0) {
        await refresh();
        notify("success", `Imported ${plural(n, "scenario")}`);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return {
    autoresponder,
    setAutoresponder,
    refresh,
    selectRuleId,
    bulkMockProgress,
    activateScenario,
    createScenario,
    renameScenario,
    deleteScenario,
    createRule,
    loadRule,
    updateRule,
    deleteRule,
    duplicateRule,
    reorderRule,
    mockFlows,
    exportRules,
    importRules,
    ruleHits,
    resetRuleState,
  };
}

/**
 * Keyboard undo/redo. `version` bumps on every undo/redo so the open rule editor
 * re-fetches the reverted rule; each also refreshes the autoresponder summary
 * (traffic changes ride the live `FlowEvent::Resync` path).
 */
function useHistory(refreshAutoresponder: () => Promise<void>, setError: SetError) {
  const [version, setVersion] = useState(0);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
        setVersion((v) => v + 1);
        await refreshAutoresponder();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshAutoresponder, setError],
  );

  const undo = useCallback(() => void run(api.historyUndo), [run]);
  const redo = useCallback(() => void run(api.historyRedo), [run]);

  return { version, undo, redo };
}

function usePersistentColumns(headerColumns: string[]) {
  const [columnOrder, setColumnOrder] = useState<string[]>(() => loadColumnOrder());

  useEffect(() => {
    localStorage.setItem("germi.columns", JSON.stringify(columnOrder));
  }, [columnOrder]);

  const visibleColumns = useMemo(
    () => resolveColumns(columnOrder, headerColumns),
    [columnOrder, headerColumns],
  );

  return { columnOrder, setColumnOrder, visibleColumns };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function useSession(setError: SetError, onOpened: () => void, notify: Notify) {
  async function saveSession() {
    try {
      const ok = await api.saveSession();
      if (ok) notify("success", "Session saved");
    } catch (e) {
      setError(String(e));
    }
  }
  async function openCapture() {
    try {
      const n = await api.openCapture();
      if (n === null) return;
      onOpened();
      notify("success", `Opened ${plural(n, "flow")}`);
    } catch (e) {
      setError(String(e));
    }
  }
  return { saveSession, openCapture };
}

async function copyFlowAsCurlAction(id: string, notify: Notify, setError: SetError) {
  try {
    const d = await api.getFlow(id, true, true);
    if (!d) return;
    await navigator.clipboard.writeText(toCurl(d));
    notify("success", "cURL command copied");
  } catch (e) {
    setError(String(e));
  }
}

async function copyFlowBodyAction(id: string, decode: boolean, notify: Notify, setError: SetError) {
  try {
    const d = await api.getFlow(id, decode, true);
    const body = d?.response?.bodyText || d?.request.bodyText || "";
    if (!body) {
      notify("info", "No body to copy");
      return;
    }
    await navigator.clipboard.writeText(body);
    notify("success", "Body copied");
  } catch (e) {
    setError(String(e));
  }
}

type PendingSelect = { nextId: string | null; deleted: Set<string> } | null;

/** Imported vs live-captured split, for the contextual "Delete captured" button. */
function countFlows(flows: FlowSummary[]): { imported: number; captured: number } {
  let imported = 0;
  for (const f of flows) if (f.imported) imported++;
  return { imported, captured: flows.length - imported };
}

/** Prune every live-captured (non-imported) flow, keeping the imported reference
 *  — the "clear the replay noise" action (issue #49). Reuses the same deferred-
 *  selection machinery as deleteSelected (the backend `removed` event drops the
 *  rows; it's undoable via Ctrl/⌘ Z). */
function deleteCapturedAction(
  flows: FlowSummary[],
  orderRef: MutableRefObject<string[]>,
  selectedId: string | null,
  pendingSelectRef: MutableRefObject<PendingSelect>,
  notify: Notify,
  setError: SetError,
): void {
  const capturedIds = flows.filter((f) => !f.imported).map((f) => f.id);
  if (capturedIds.length === 0) {
    notify("info", "No captured requests to delete");
    return;
  }
  const deleted = new Set(capturedIds);
  pendingSelectRef.current = {
    nextId: nextIdAfterDelete(orderRef.current, deleted, selectedId),
    deleted,
  };
  void api
    .removeCapturedFlows()
    .then(() => notify("success", `Deleted ${plural(capturedIds.length, "captured request")}`))
    .catch((e) => {
      pendingSelectRef.current = null;
      setError(String(e));
    });
}

/** Bundles the imported/captured split and the "Delete captured" action (issue
 *  #49) so the composition root just wires it, like the other feature hooks. */
function useCapturedDelete(
  flows: FlowSummary[],
  orderRef: MutableRefObject<string[]>,
  selectedId: string | null,
  pendingSelectRef: MutableRefObject<PendingSelect>,
  notify: Notify,
  setError: SetError,
) {
  const counts = useMemo(() => countFlows(flows), [flows]);
  const deleteCaptured = () =>
    deleteCapturedAction(flows, orderRef, selectedId, pendingSelectRef, notify, setError);
  return { deleteCaptured, capturedCount: counts.captured, importedCount: counts.imported };
}

function useViewState() {
  const [rightTab, setRightTabState] = useState<RightTab>(() =>
    loadString("germi.rightTab", ["inspector", "autoresponder"] as const, "inspector"),
  );
  const setRightTab = useCallback((tab: RightTab) => {
    setRightTabState(tab);
    persist("germi.rightTab", tab);
  }, []);
  const [rightMode, setRightModeState] = useState<RightMode>(() =>
    loadString("germi.rightMode", ["single", "split"] as const, "single"),
  );
  const setRightMode = useCallback((mode: RightMode) => {
    setRightModeState(mode);
    persist("germi.rightMode", mode);
  }, []);

  const [decode, setDecode] = useState(true);
  const [fullBody, setFullBody] = useState(false);
  const [caOpen, setCaOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rightCollapsed, setRightCollapsedState] = useState(() =>
    loadBool("germi.rightCollapsed", false),
  );
  const setRightCollapsed = useCallback((v: boolean) => {
    setRightCollapsedState(v);
    persist("germi.rightCollapsed", v ? "1" : "0");
  }, []);
  const filterInputRef = useRef<HTMLInputElement>(null);

  return {
    rightTab,
    setRightTab,
    rightMode,
    setRightMode,
    decode,
    setDecode,
    fullBody,
    setFullBody,
    caOpen,
    setCaOpen,
    confirmClear,
    setConfirmClear,
    confirmOpen,
    setConfirmOpen,
    rightCollapsed,
    setRightCollapsed,
    filterInputRef,
  };
}

// On-demand doc public-availability check (issue #40). Scope: an explicit
// selection or filter narrows the set; with neither, fall back to doc-kind flows
// without a verdict yet (a re-click only re-checks the unknowns). The backend
// re-issues GET/HEAD only and streams each verdict back on the live flow channel.
function useAvailabilityCheck(
  flows: FlowSummary[],
  selectedIds: Set<string>,
  matchedIds: Set<string> | null,
  notify: Notify,
  setError: SetError,
) {
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityProgress | null>(null);

  function candidates(): string[] {
    if (selectedIds.size > 0) {
      return flows.filter((f) => selectedIds.has(f.id)).map((f) => f.id);
    }
    const matched = matchedIds;
    if (matched) {
      return flows.filter((f) => matched.has(f.id)).map((f) => f.id);
    }
    return flows.filter((f) => f.kind === "doc" && f.availability == null).map((f) => f.id);
  }

  async function checkAvailability() {
    if (availabilityCheck) return;
    const ids = candidates();
    if (ids.length === 0) {
      notify("info", "No requests to check for availability");
      return;
    }
    setAvailabilityCheck({ completed: 0, total: ids.length });
    try {
      const checked = await api.checkDocAvailability(ids, (p) => setAvailabilityCheck(p));
      notify(
        checked > 0 ? "success" : "info",
        checked > 0
          ? `Checked ${plural(checked, "request")} for public availability`
          : "Nothing checkable (only GET/HEAD requests are tested)",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setAvailabilityCheck(null);
    }
  }

  return { checkAvailability, availabilityCheck };
}

export function useAppState() {
  const toasts = useToasts();
  const notify = toasts.notify;
  const setError = useCallback<SetError>(
    (value) => {
      if (value) notify("error", value);
    },
    [notify],
  );

  const {
    rightTab,
    setRightTab,
    rightMode,
    setRightMode,
    decode,
    setDecode,
    fullBody,
    setFullBody,
    caOpen,
    setCaOpen,
    confirmClear,
    setConfirmClear,
    confirmOpen,
    setConfirmOpen,
    rightCollapsed,
    setRightCollapsed,
    filterInputRef,
  } = useViewState();
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);

  const settings = useSettings();
  const flowStore = useFlowStore(settings.settings.maxFlows, setError);
  const filtering = useTrafficFilter(flowStore.flows, setError);
  const selection = useSelection(flowStore.flows);
  const selectedSummary = selection.selectedId
    ? flowStore.flowsRef.current.get(selection.selectedId)
    : undefined;
  const selectedSummaries = useMemo(
    () => flowStore.flows.filter((f) => selection.selectedIds.has(f.id)),
    [flowStore.flows, selection.selectedIds],
  );
  const inspector = useFlowDetail(selection.selectedId, decode, fullBody, selectedSummary);
  const availability = useAvailabilityCheck(
    flowStore.flows,
    selection.selectedIds,
    filtering.matchedIds,
    notify,
    setError,
  );

  // Deferred selection after delete: we don't move the selection until the
  // deleted rows have actually been pruned by the backend's `removed` event,
  // so the row-swap and the highlight move land in the same frame instead of
  // "next lights up, then old pops out and lit row jumps up" (issue #4).
  const pendingSelectRef = useRef<PendingSelect>(null);
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (!pending) return;
    const order = flowStore.orderRef.current;
    if (pending.deleted.size > 0 && order.some((id) => pending.deleted.has(id))) return;
    pendingSelectRef.current = null;
    if (pending.nextId === null || !order.includes(pending.nextId)) {
      selection.clearSelection();
      inspector.setDetail(null);
    } else {
      selection.selectByKeyboard(pending.nextId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowStore.flows]);

  const captured = useCapturedDelete(
    flowStore.flows,
    flowStore.orderRef,
    selection.selectedId,
    pendingSelectRef,
    notify,
    setError,
  );

  const proxy = useProxyControl(
    settings.settings,
    setError,
    (port) => saveSettings({ ...settings.settings, port }),
    notify,
  );
  useSystemHotkeys(settings.settings.systemProxyHotkey, proxy.toggleSystemProxyHotkey, setError);
  useProxyIndicator(proxy.systemProxy);
  const autoresponderActive = rightTab === "autoresponder" || rightMode === "split";
  const ar = useAutoresponder(setError, setRightTab, notify, autoresponderActive);
  const history = useHistory(ar.refresh, setError);
  const columns = usePersistentColumns(settings.settings.headerColumns);
  const session = useSession(
    setError,
    () => {
      selection.clearSelection();
      inspector.setDetail(null);
    },
    notify,
  );
  const trafficSplit = useSplitRatio({
    initial: 0.55,
    min: 0.18,
    max: 0.82,
    storageKey: "germi.trafficSplit",
  });

  useEffect(() => {
    void loadInitialState({
      setRunning: proxy.setRunning,
      setAutoresponder: ar.setAutoresponder,
      setSettings: settings.setSettings,
      setCaInfo,
      loadInitialFlows: flowStore.loadInitial,
      setError,
    });
    const focusTimer = window.setTimeout(() => filterInputRef.current?.focus(), 60);
    return () => clearTimeout(focusTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveSettings(next: ProxySettings) {
    settings.setSettings(next);
    persistSettings(next, settings.settings.headerColumns, flowStore.refresh, setError);
  }

  function applyImportedSettings(next: ProxySettings) {
    const headersChanged =
      JSON.stringify(next.headerColumns) !== JSON.stringify(settings.settings.headerColumns);
    settings.setSettings(next);
    if (headersChanged) void flowStore.refresh().catch((e) => setError(String(e)));
  }

  function handleRowClick(id: string, e: ReactMouseEvent) {
    setFullBody(false);
    selection.onRowClick(id, e);
    // In split mode both panes are visible, so don't yank the user out of the
    // rule they're editing; only force the Inspector tab in single mode.
    if (rightMode === "single") setRightTab("inspector");
  }

  function handleKeySelect(id: string, extend: boolean) {
    setFullBody(false);
    selection.selectByKeyboard(id, extend);
    if (rightMode === "single" && !extend) setRightTab("inspector");
  }

  function selectAllVisible() {
    const matched = filtering.matchedIds;
    const ids = matched
      ? flowStore.flows.filter((f) => matched.has(f.id)).map((f) => f.id)
      : flowStore.flows.map((f) => f.id);
    selection.selectAll(ids);
    if (ids.length > 1 && rightMode === "single") setRightTab("inspector");
  }

  function mockFlow(id: string) {
    void ar.mockFlows([id], ar.autoresponder.activeScenarioId);
  }

  function dropMockFlows(ids: string[], scenarioId: string | null) {
    void ar.mockFlows(ids, scenarioId).then((ok) => {
      if (ok) selection.deselect(ids);
    });
  }

  function filterToHost(host: string) {
    filtering.setFilter(`host:${host}`);
    filterInputRef.current?.focus();
  }

  function excludeHost(host: string) {
    const cur = settings.settings.excludedHosts;
    if (cur.includes(host)) {
      notify("info", `${host} is already excluded`);
      return;
    }
    saveSettings({ ...settings.settings, excludedHosts: [...cur, host] });
    notify("success", `Excluded ${host} from interception`);
  }

  const copyFlowAsCurl = (id: string) => copyFlowAsCurlAction(id, notify, setError);
  const copyFlowBody = (id: string) => copyFlowBodyAction(id, decode, notify, setError);

  function copySelectedUrl() {
    const fs = selectedSummary;
    if (!fs) {
      notify("info", "No request selected");
      return;
    }
    void navigator.clipboard.writeText(flowUrl(fs));
    notify("success", "URL copied");
  }

  // F2: reveal the Autoresponder (un-collapse / switch to its tab in single
  // mode), then focus the mock response-body editor if a respond rule is open.
  function focusMockBody() {
    if (rightCollapsed) setRightCollapsed(false);
    if (rightMode === "single") setRightTab("autoresponder");
    focusMockResponseBody();
  }

  function clearTraffic() {
    void api.clearFlows();
    selection.clearSelection();
    inspector.setDetail(null);
  }

  function requestClearTraffic() {
    if (flowStore.orderRef.current.length === 0) return;
    setConfirmClear(true);
  }

  function confirmClearTraffic() {
    setConfirmClear(false);
    clearTraffic();
  }

  function requestOpenCapture() {
    if (flowStore.orderRef.current.length === 0) {
      void session.openCapture();
      return;
    }
    setConfirmOpen(true);
  }

  function confirmOpenCapture() {
    setConfirmOpen(false);
    void session.openCapture();
  }

  // Prune the selected flows (no confirm — the backend `removed` event drops
  // the rows). The actual selection move is deferred until those rows are gone
  // (see pendingSelectRef effect above), so the highlight transfer and the row
  // removal happen in one frame instead of two (issue #4).
  function deleteSelected() {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const nextId = nextIdAfterDelete(
      flowStore.orderRef.current,
      new Set(ids),
      selection.selectedId,
    );
    pendingSelectRef.current = { nextId, deleted: new Set(ids) };
    void api.removeFlows(ids).catch((e) => {
      pendingSelectRef.current = null;
      setError(String(e));
    });
  }

  function refreshCa() {
    void api.caInfo().then(setCaInfo);
  }

  const activeScenario =
    ar.autoresponder.scenarios.find((s) => s.id === ar.autoresponder.activeScenarioId)?.name ??
    null;

  const matchCount = filtering.matchedIds ? filtering.matchedIds.size : null;

  return {
    setError,
    notify,
    toasts: toasts.toasts,
    dismissToast: toasts.dismiss,
    checkAvailability: availability.checkAvailability,
    availabilityCheck: availability.availabilityCheck,
    rightTab,
    setRightTab,
    rightMode,
    setRightMode,
    decode,
    setDecode,
    setFullBody,
    caInfo,
    caOpen,
    setCaOpen,
    rightCollapsed,
    setRightCollapsed,
    filterInputRef,
    confirmClear,
    setConfirmClear,
    requestClearTraffic,
    confirmClearTraffic,
    confirmOpen,
    setConfirmOpen,
    requestOpenCapture,
    confirmOpenCapture,
    settings,
    flowStore,
    filtering,
    selection,
    selectedSummary,
    selectedSummaries,
    selectAllVisible,
    inspector,
    proxy,
    ar,
    history,
    columns,
    session,
    trafficSplit,
    saveSettings,
    applyImportedSettings,
    handleRowClick,
    handleKeySelect,
    mockFlow,
    dropMockFlows,
    filterToHost,
    excludeHost,
    copyFlowAsCurl,
    copyFlowBody,
    copySelectedUrl,
    focusMockBody,
    clearTraffic,
    deleteSelected,
    deleteCaptured: captured.deleteCaptured,
    capturedCount: captured.capturedCount,
    importedCount: captured.importedCount,
    refreshCa,
    activeScenario,
    matchCount,
  };
}
