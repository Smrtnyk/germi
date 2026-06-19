import {
  useCallback,
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
import { useToasts, type Notify } from "./toast";
import { toCurl } from "./curl";
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
      setSelectedIds((prev) => toggledSet(prev, id));
      setSelectedId(id);
      anchorRef.current = id;
    } else {
      extendOrSelect(id, false);
    }
  }

  function selectByKeyboard(id: string, extend: boolean) {
    extendOrSelect(id, extend);
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
    selectByKeyboard,
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
        const boundPort = await api.startProxy(settings.port, settings.allowRemote);
        if (boundPort !== settings.port) onPortBound(boundPort);
        setRunning(true);
        notify(
          "success",
          `Proxy listening on ${settings.allowRemote ? "0.0.0.0" : "127.0.0.1"}:${boundPort}`,
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSystemProxy() {
    try {
      if (systemProxy) {
        await api.clearSystemProxy();
        setSystemProxy(false);
      } else {
        await api.setSystemProxy(settings.port);
        setSystemProxy(true);
        notify("info", "System proxy now routed through Germi");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return { running, setRunning, systemProxy, busy, toggleProxy, toggleSystemProxy };
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

function useAutoresponder(
  setError: SetError,
  setRightTab: (tab: RightTab) => void,
  notify: Notify,
  autoresponderActive: boolean,
) {
  const [autoresponder, setAutoresponder] = useState<AutoResponder>({
    scenarios: [],
    activeScenarioId: null,
  });
  const [selectRuleId, setSelectRuleId] = useState<string | null>(null);
  const [pickScenarioId, setPickScenarioId] = useState("");
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<AutoResponder | null>(null);
  const { ruleHits, resetRuleState } = useRuleHits(
    autoresponder.activeScenarioId,
    autoresponderActive,
    setError,
  );

  function cancelSave() {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSave.current = null;
  }

  async function flushSave() {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const next = pendingSave.current;
    pendingSave.current = null;
    if (next === null) return;
    try {
      await api.setAutoresponder(next);
    } catch (e) {
      setError(String(e));
    }
  }

  function saveAutoresponder(next: AutoResponder) {
    setAutoresponder(next);
    pendingSave.current = next;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const pending = pendingSave.current;
      saveTimer.current = null;
      pendingSave.current = null;
      if (pending !== null) void api.setAutoresponder(pending).catch((e) => setError(String(e)));
    }, 300);
  }

  async function mockFlows(ids: string[], scenarioId: string | null): Promise<boolean> {
    setError(null);
    await flushSave();
    try {
      const result = await api.mockFlows(ids, scenarioId);
      setAutoresponder(result.autoresponder);
      setSelectRuleId(result.newRuleIds[0] ?? null);
      setRightTab("autoresponder");
      const n = result.newRuleIds.length;
      notify("success", n > 1 ? `Created ${plural(n, "mock rule")}` : "Mock rule created");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  async function exportRules(scenarioId: string | null) {
    await flushSave();
    try {
      const ok = await api.exportRules(scenarioId);
      if (ok) notify("success", scenarioId ? "Scenario exported" : "All scenarios exported");
    } catch (e) {
      setError(String(e));
    }
  }

  async function importRules(replace: boolean) {
    cancelSave();
    try {
      const n = await api.importRules(replace);
      if (n > 0) {
        setAutoresponder(await api.getAutoresponder());
        notify("success", `Imported ${plural(n, "scenario")}`);
      }
    } catch (e) {
      setError(String(e));
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
    exportRules,
    importRules,
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function useSession(setError: SetError, onOpened: () => void, notify: Notify) {
  async function importArchive() {
    try {
      const n = await api.importArchive();
      if (n > 0) notify("success", `Imported ${plural(n, "flow")} from archive`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function saveSession() {
    try {
      const ok = await api.saveSession();
      if (ok) notify("success", "Session saved");
    } catch (e) {
      setError(String(e));
    }
  }
  async function openSession() {
    try {
      const n = await api.openSession();
      onOpened();
      if (n >= 0) notify("success", `Opened session — ${plural(n, "flow")}`);
    } catch (e) {
      setError(String(e));
    }
  }
  return { importArchive, saveSession, openSession };
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
  const [trafficMin, setTrafficMin] = useState(640);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const [theme, setTheme] = useState<"dark" | "light">(() =>
    loadString("germi.theme", ["dark", "light"] as const, "dark"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persist("germi.theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

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
    trafficMin,
    setTrafficMin,
    filterInputRef,
    theme,
    toggleTheme,
  };
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
    trafficMin,
    setTrafficMin,
    filterInputRef,
    theme,
    toggleTheme,
  } = useViewState();
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);

  const settings = useSettings();
  const flowStore = useFlowStore(settings.settings.maxFlows, setError);
  const filtering = useTrafficFilter(flowStore.flows, setError);
  const selection = useSelection(flowStore.flows);
  const selectedSummary = selection.selectedId
    ? flowStore.flowsRef.current.get(selection.selectedId)
    : undefined;
  const inspector = useFlowDetail(selection.selectedId, decode, fullBody, selectedSummary);
  const proxy = useProxyControl(
    settings.settings,
    setError,
    (port) => saveSettings({ ...settings.settings, port }),
    notify,
  );
  const autoresponderActive = rightTab === "autoresponder" || rightMode === "split";
  const ar = useAutoresponder(setError, setRightTab, notify, autoresponderActive);
  const columns = usePersistentColumns(settings.settings.headerColumns);
  const session = useSession(
    setError,
    () => {
      selection.clearSelection();
      inspector.setDetail(null);
    },
    notify,
  );
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

  function mockFlow(id: string) {
    void ar.mockFlows([id], ar.autoresponder.activeScenarioId);
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

  // Prune the selected flows (no confirm — the backend `removed` event drops the
  // rows); clear the now-stale selection + detail, like clearTraffic does.
  function deleteSelected() {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    void api.removeFlows(ids).catch((e) => setError(String(e)));
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
    setError,
    notify,
    toasts: toasts.toasts,
    dismissToast: toasts.dismiss,
    rightTab,
    setRightTab,
    rightMode,
    setRightMode,
    decode,
    setDecode,
    theme,
    toggleTheme,
    setFullBody,
    caInfo,
    caOpen,
    setCaOpen,
    setTrafficMin,
    filterInputRef,
    confirmClear,
    setConfirmClear,
    requestClearTraffic,
    confirmClearTraffic,
    settings,
    flowStore,
    filtering,
    selection,
    selectedSummary,
    inspector,
    proxy,
    ar,
    columns,
    session,
    trafficResize,
    saveSettings,
    applyImportedSettings,
    handleRowClick,
    handleKeySelect,
    mockFlow,
    filterToHost,
    excludeHost,
    copyFlowAsCurl,
    copyFlowBody,
    clearTraffic,
    deleteSelected,
    refreshCa,
    activeScenario,
    matchCount,
  };
}
