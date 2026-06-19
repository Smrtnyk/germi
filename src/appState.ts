import {
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { api, subscribeFlows } from "./ipc";
import { parseFilter, statusClass, type BodyTerm, type ParsedFilter } from "./filter";
import { resolveColumns, DEFAULT_COLUMNS } from "./columns";
import { useResizable } from "./useResizable";
import type {
  AutoResponder,
  CaInfo,
  FlowDetail,
  FlowEvent,
  FlowSummary,
  ProxySettings,
  ResourceKind,
} from "./types";

export type RightTab = "inspector" | "autoresponder";

type SetError = (value: string | null) => void;

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
  try {
    const fresh = await api.listFlows();
    map.clear();
    order.length = 0;
    for (const s of fresh) {
      order.push(s.id);
      map.set(s.id, s);
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
  setAutoresponder: (ar: AutoResponder) => void;
  setSettings: (s: ProxySettings) => void;
  setCaInfo: (ca: CaInfo) => void;
  loadInitialFlows: () => Promise<void>;
  setError: SetError;
}): Promise<void> {
  try {
    const isRunning = await api.proxyStatus();
    opts.setRunning(isRunning);
    opts.setAutoresponder(await api.getAutoresponder());
    const loaded = await api.getSettings();
    opts.setSettings(loaded);
    opts.setCaInfo(await api.caInfo());
    await opts.loadInitialFlows();
    if (loaded.captureOnStart && !isRunning) {
      await api.startProxy(loaded.port, loaded.allowRemote);
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
    });
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

function useTrafficFilter(flows: FlowSummary[], tick: number, setError: SetError) {
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
  }, [deferredFilter, typeChips, statusChips, tick]);

  const matchedIds = useMemo(
    () => intersectMatches(hasFilter, summaryMatched, bodyMatchIds, parsed.bodyTerms.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFilter, summaryMatched, bodyMatchIds, deferredFilter],
  );

  return {
    filter,
    setFilter,
    typeChips,
    statusChips,
    toggleTypeChip: (k: ResourceKind) => setTypeChips((prev) => toggledSet(prev, k)),
    toggleStatusChip: (c: string) => setStatusChips((prev) => toggledSet(prev, c)),
    matchedIds,
    searching,
  };
}

function useSelection(flows: FlowSummary[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  function onRowClick(id: string, e: ReactMouseEvent) {
    if (e.shiftKey && anchorRef.current) {
      const range = rangeSelection(
        flows.map((f) => f.id),
        anchorRef.current,
        id,
      );
      if (range) setSelectedIds(range);
      setSelectedId(id);
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => toggledSet(prev, id));
      setSelectedId(id);
      anchorRef.current = id;
    } else {
      setSelectedIds(new Set([id]));
      setSelectedId(id);
      anchorRef.current = id;
    }
  }

  function clearSelection() {
    setSelectedId(null);
    setSelectedIds(new Set());
  }

  return {
    selectedId,
    selectedIds,
    setSelectedIds,
    onRowClick,
    clearSelection,
  };
}

function useFlowDetail(
  selectedId: string | null,
  decode: boolean,
  fullBody: boolean,
  selectedSummary: FlowSummary | undefined,
) {
  const [detail, setDetail] = useState<FlowDetail | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    void api.getFlow(selectedId, decode, fullBody).then((d) => {
      if (active) setDetail(d);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, decode, fullBody, selectedSummary?.status, selectedSummary?.durationMs]);

  return { detail, setDetail };
}

function useProxyControl(settings: ProxySettings, setError: SetError) {
  const [running, setRunning] = useState(false);
  const [systemProxy, setSystemProxy] = useState(false);

  async function toggleProxy() {
    setError(null);
    try {
      if (running) {
        if (systemProxy) {
          await api.clearSystemProxy().catch(() => {});
          setSystemProxy(false);
        }
        await api.stopProxy();
        setRunning(false);
      } else {
        await api.startProxy(settings.port, settings.allowRemote);
        setRunning(true);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleSystemProxy() {
    setError(null);
    try {
      if (systemProxy) {
        await api.clearSystemProxy();
        setSystemProxy(false);
      } else {
        await api.setSystemProxy(settings.port);
        setSystemProxy(true);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return { running, setRunning, systemProxy, toggleProxy, toggleSystemProxy };
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
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  return { settings, setSettings, settingsOpen, setSettingsOpen };
}

function useRuleHits(
  flowTick: number,
  activeScenarioId: string | null,
  active: boolean,
  setError: SetError,
) {
  const [ruleHits, setRuleHits] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      void api.ruleHits().then((h) => {
        if (!cancelled) setRuleHits(h);
      });
    const handle = window.setTimeout(poll, 250);
    const interval = active ? window.setInterval(poll, 1500) : null;
    return () => {
      cancelled = true;
      clearTimeout(handle);
      if (interval !== null) clearInterval(interval);
    };
  }, [flowTick, activeScenarioId, active]);

  function resetRuleState(scenarioId: string | null) {
    void api
      .resetRuleState(scenarioId)
      .then(() => api.ruleHits())
      .then(setRuleHits)
      .catch((e) => setError(String(e)));
  }

  return { ruleHits, resetRuleState };
}

function useAutoresponder(
  setError: SetError,
  setRightTab: (tab: RightTab) => void,
  flowTick: number,
  rightTab: RightTab,
) {
  const [autoresponder, setAutoresponder] = useState<AutoResponder>({
    scenarios: [],
    activeScenarioId: null,
  });
  const [selectRuleId, setSelectRuleId] = useState<string | null>(null);
  const [pickScenarioId, setPickScenarioId] = useState("");
  const saveTimer = useRef<number | null>(null);
  const { ruleHits, resetRuleState } = useRuleHits(
    flowTick,
    autoresponder.activeScenarioId,
    rightTab === "autoresponder",
    setError,
  );

  function saveAutoresponder(next: AutoResponder) {
    setAutoresponder(next);
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.setAutoresponder(next).catch((e) => setError(String(e)));
    }, 300);
  }

  async function mockFlows(ids: string[], scenarioId: string | null): Promise<boolean> {
    setError(null);
    try {
      const result = await api.mockFlows(ids, scenarioId);
      setAutoresponder(result.autoresponder);
      setSelectRuleId(result.newRuleIds[0] ?? null);
      setRightTab("autoresponder");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  return {
    autoresponder,
    setAutoresponder,
    selectRuleId,
    pickScenarioId,
    setPickScenarioId,
    saveAutoresponder,
    mockFlows,
    ruleHits,
    resetRuleState,
  };
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

function useSession(setError: SetError, onOpened: () => void) {
  async function importArchive() {
    setError(null);
    try {
      await api.importArchive();
    } catch (e) {
      setError(String(e));
    }
  }
  async function saveSession() {
    setError(null);
    try {
      await api.saveSession();
    } catch (e) {
      setError(String(e));
    }
  }
  async function openSession() {
    setError(null);
    try {
      await api.openSession();
      onOpened();
    } catch (e) {
      setError(String(e));
    }
  }
  return { importArchive, saveSession, openSession };
}

export function useAppState() {
  const [error, setError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("inspector");
  const [decode, setDecode] = useState(true);
  const [fullBody, setFullBody] = useState(false);
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);
  const [caOpen, setCaOpen] = useState(false);
  const [trafficMin, setTrafficMin] = useState(640);

  const settings = useSettings();
  const flowStore = useFlowStore(settings.settings.maxFlows, setError);
  const filtering = useTrafficFilter(flowStore.flows, flowStore.tick, setError);
  const selection = useSelection(flowStore.flows);
  const selectedSummary = selection.selectedId
    ? flowStore.flowsRef.current.get(selection.selectedId)
    : undefined;
  const inspector = useFlowDetail(selection.selectedId, decode, fullBody, selectedSummary);
  const proxy = useProxyControl(settings.settings, setError);
  const ar = useAutoresponder(setError, setRightTab, flowStore.tick, rightTab);
  const columns = usePersistentColumns(settings.settings.headerColumns);
  const session = useSession(setError, () => {
    selection.clearSelection();
    inspector.setDetail(null);
  });
  const trafficResize = useResizable({
    initial: 760,
    min: trafficMin,
    getMax: () => window.innerWidth - 440,
    storageKey: "germi.trafficWidth",
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveSettings(next: ProxySettings) {
    settings.setSettings(next);
    persistSettings(next, settings.settings.headerColumns, flowStore.refresh, setError);
  }

  function handleRowClick(id: string, e: ReactMouseEvent) {
    setFullBody(false);
    selection.onRowClick(id, e);
    setRightTab("inspector");
  }

  function clearTraffic() {
    void api.clearFlows();
    selection.clearSelection();
    inspector.setDetail(null);
  }

  function refreshCa() {
    void api.caInfo().then(setCaInfo);
  }

  const activeScenario =
    ar.autoresponder.scenarios.find((s) => s.id === ar.autoresponder.activeScenarioId)?.name ??
    null;

  const matchCount = filtering.matchedIds ? filtering.matchedIds.size : null;

  return {
    error,
    setError,
    rightTab,
    setRightTab,
    decode,
    setDecode,
    setFullBody,
    caInfo,
    caOpen,
    setCaOpen,
    setTrafficMin,
    settings,
    flowStore,
    filtering,
    selection,
    inspector,
    proxy,
    ar,
    columns,
    session,
    trafficResize,
    saveSettings,
    handleRowClick,
    clearTraffic,
    refreshCa,
    activeScenario,
    matchCount,
  };
}
