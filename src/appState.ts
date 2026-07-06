import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";

import { compact, isEqual } from "es-toolkit";

import { announce } from "./announce";
import { api, subscribeFlows } from "./ipc";
import { openOrFocusCompareWindow } from "./compareWindow";
import {
  currentWindowLabel,
  emitRulesChanged,
  listOpenRuleIds,
  onRuleWindowClosed,
  onRuleWindowResized,
  onRulesChanged,
  openOrFocusRuleWindow,
  saveRuleWindowSize,
} from "./ruleWindows";
import { loadBool, loadJson, loadString, persist } from "./localStore";
import { useTrafficFilter } from "./useTrafficFilter";
import { useSavedFilters } from "./useSavedFilters";
import { savedFilterLabel } from "./savedFilters";
import { backfillSeqColumn, resolveColumns, DEFAULT_COLUMNS, type ColumnDef } from "./columns";
import { nextSort, resolveSort, sortFlows, type SortState } from "./sort";
import { useSplitRatio } from "./useResizable";
import { useProxyIndicator } from "./useProxyIndicator";
import { useSystemHotkeys } from "./useSystemHotkeys";
import { friendlyError, useToasts, type Notify } from "./toast";
import { toCurl } from "./curl";
import { flowUrl } from "./flowUrl";
import { focusMockResponseBody } from "./focusMockBody";
import { nextIdAfterDelete, rangeSelection, toggleSelection } from "./selection";
import { resolveBindings, type Bindings } from "./shortcuts";
import { emitSettingsChanged } from "./themeSync";
import { readFileAsBase64 } from "./captureDrop";
import type { CaptureExt } from "./dnd";
import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  insertRuleSummaryAfter,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
  ruleLabel,
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
  Rule,
  RuleSummary,
  ScenarioSummary,
} from "./types";

export type RightTab = "inspector" | "autoresponder" | "filters" | "scripts";
export type RightMode = "single" | "split";
/** Where the autoresponder rule detail sits relative to the list (issue #72). */
export type AutoLayout = "side" | "stacked";

type SetError = (value: string | null) => void;

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

// The backend FlowStore is the single source of truth for retention: it evicts
// past max_flows and emits `Removed` for whatever it drops (issue #80), so this
// just mirrors the event stream. There is deliberately no independent cap here —
// one would evict different flows than the backend and desync the two lists
// (stale rows the store can't inspect; imported rows silently dropped).
function applyFlowEvents(
  map: Map<string, FlowSummary>,
  order: string[],
  events: FlowEvent[],
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
  return resync;
}

/** Rebuild the flow list from an authoritative backend snapshot, in backend
 *  (capture) order. The resync path uses this so a flow the backend restored
 *  (undo) or reordered lands at its real position instead of being appended at
 *  the tail, and a row the backend dropped can't linger as a ghost. */
function rebuildFromSnapshot(
  map: Map<string, FlowSummary>,
  order: string[],
  fresh: FlowSummary[],
): void {
  map.clear();
  order.length = 0;
  for (const s of fresh) {
    order.push(s.id);
    map.set(s.id, s);
  }
}

function collectFlows(order: string[], map: Map<string, FlowSummary>): FlowSummary[] {
  return compact(order.map((id) => map.get(id)));
}

function mergeFlows(order: string[], map: Map<string, FlowSummary>, list: FlowSummary[]): void {
  for (const s of list) {
    if (!map.has(s.id)) order.push(s.id);
    map.set(s.id, s);
  }
}

function loadColumnOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem("germi.columns") ?? "null");
    if (!Array.isArray(saved) || !saved.length) return DEFAULT_COLUMNS;
    const marked = localStorage.getItem("germi.columns.seqBackfilled") !== null;
    if (!marked) localStorage.setItem("germi.columns.seqBackfilled", "1");
    return backfillSeqColumn(saved, marked);
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
  const headersChanged = !isEqual(next.headerColumns, prevHeaderColumns);
  void api
    .setSettings(next)
    .then(async () => {
      emitSettingsChanged();
      if (headersChanged) await refresh();
    })
    .catch((e) => setError(String(e)));
}

async function loadInitialState(opts: {
  setRunning: (running: boolean) => void;
  setBoundPort: (port: number) => void;
  setBoundAllowRemote: (allowRemote: boolean) => void;
  setViewer: (viewer: boolean) => void;
  setAutoresponder: (ar: AutoResponderSummary) => void;
  setSettings: (s: ProxySettings) => void;
  setCaInfo: (ca: CaInfo) => void;
  loadInitialFlows: () => Promise<void>;
  setError: SetError;
}): Promise<void> {
  try {
    const viewer = await api.isViewerMode();
    opts.setViewer(viewer);
    const isRunning = await api.proxyStatus();
    opts.setRunning(isRunning);
    // If the proxy is already up (e.g. the webview reloaded while the Rust proxy
    // kept running), re-read the real bound address so the status bar and the
    // system-proxy target reflect reality, not the persisted (maybe-drifted) port.
    if (isRunning) {
      const addr = await api.boundAddr();
      if (addr) {
        opts.setBoundPort(addr.port);
        opts.setBoundAllowRemote(addr.allowRemote);
      }
    }
    opts.setAutoresponder(await api.getAutoresponderSummary());
    const loaded = await api.getSettings();
    opts.setSettings(loaded);
    opts.setCaInfo(await api.caInfo());
    await opts.loadInitialFlows();
    // Never auto-start the proxy in a viewer instance — it has no proxy to run.
    if (loaded.autoStartOnLaunch && !isRunning && !viewer) {
      // Best-effort: a taken port is reported but must not abort the rest of init.
      try {
        const boundPort = await api.startProxy(loaded.port, loaded.allowRemote);
        if (boundPort !== loaded.port) opts.setSettings({ ...loaded, port: boundPort });
        opts.setBoundPort(boundPort);
        opts.setBoundAllowRemote(loaded.allowRemote);
        opts.setRunning(true);
      } catch (e) {
        opts.setError(
          `Couldn't auto-start the proxy on port ${loaded.port} (${e}). ` +
            `Change the port in Settings → Connections, then press Start.`,
        );
      }
    }
  } catch (e) {
    opts.setError(String(e));
  }
}

function useFlowStore(setError: SetError) {
  const flowsRef = useRef<Map<string, FlowSummary>>(new Map());
  const orderRef = useRef<string[]>([]);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // Batches that arrive while a resync re-list is in flight are buffered and
    // replayed on top of the authoritative snapshot, so events captured during
    // the `listFlows` await are neither lost nor able to resurrect a removed row.
    const pending: FlowEvent[][] = [];
    let reconciling = false;

    async function reconcile() {
      if (reconciling) return;
      reconciling = true;
      try {
        for (;;) {
          const fresh = await api.listFlows();
          rebuildFromSnapshot(flowsRef.current, orderRef.current, fresh);
          let resync = false;
          for (let batch = pending.shift(); batch; batch = pending.shift()) {
            if (applyFlowEvents(flowsRef.current, orderRef.current, batch)) resync = true;
          }
          if (!resync) break;
        }
      } catch (e) {
        setError(String(e));
      } finally {
        reconciling = false;
        bump();
      }
    }

    const channel = subscribeFlows((events) => {
      if (reconciling) {
        pending.push(events);
        return;
      }
      const resync = applyFlowEvents(flowsRef.current, orderRef.current, events);
      bump();
      if (resync) void reconcile();
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
    // Use mergeFlows (not a bare map write): a flow captured in the batch window
    // before this snapshot lands must be pushed into `order` too, or it stays in
    // the map but never renders and no later event can heal it.
    mergeFlows(orderRef.current, flowsRef.current, await api.listFlows());
    bump();
  }

  return { flows, flowsRef, orderRef, tick, editComment, loadInitial, refresh };
}

function useSelection(flows: FlowSummary[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  // Selection follows visibility (issue #90): a row the hide-mode or solo'd
  // filter removes from the list leaves the selection too — otherwise Delete,
  // drag-to-mock and Compare would silently act on rows the user can no longer
  // see are selected. Dimmed rows stay visible, so dim mode prunes nothing.
  useEffect(() => {
    const present = new Set(flows.map((f) => f.id));
    setSelectedIds((prev) => {
      const kept = [...prev].filter((id) => present.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    setSelectedId((cur) => (cur !== null && !present.has(cur) ? null : cur));
  }, [flows]);

  function extendOrSelect(id: string, extend: boolean) {
    const range =
      extend && anchorRef.current
        ? rangeSelection(
            flows.map((f) => f.id),
            anchorRef.current,
            id,
          )
        : null;
    if (range) {
      setSelectedIds(range);
      setSelectedId(id);
    } else {
      // Fresh single selection: either not extending, or the anchor was
      // evicted/removed so a range can't be computed — re-anchor here instead of
      // moving selectedId while leaving selectedIds on the stale set.
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
  // What the proxy is ACTUALLY bound to; diverges from settings after a failed
  // restart, so the status bar and system-proxy target read this, not the
  // pending setting (otherwise the UI would claim a host/port that isn't live).
  const [boundPort, setBoundPort] = useState<number | null>(null);
  const [boundAllowRemote, setBoundAllowRemote] = useState<boolean | null>(null);
  // Last rebind failure, shown inline in Settings → Connections (a toast is
  // hidden behind the settings modal, which is where port changes come from).
  const [listenerError, setListenerError] = useState<string | null>(null);

  function markBound(port: number, allowRemote: boolean) {
    setBoundPort(port);
    setBoundAllowRemote(allowRemote);
    setListenerError(null);
  }

  async function startProxy(): Promise<number> {
    const bound = await api.startProxy(settings.port, settings.allowRemote);
    if (bound !== settings.port) onPortBound(bound);
    markBound(bound, settings.allowRemote);
    setRunning(true);
    notify(
      "success",
      `Proxy listening on ${settings.allowRemote ? "0.0.0.0" : "127.0.0.1"}:${bound}`,
    );
    return bound;
  }

  // Re-point the OS system proxy after a successful rebind. The bind already
  // happened, so a failure here is a system-proxy error, not a bind failure.
  async function repointSystemProxy(port: number) {
    if (!systemProxy) return;
    try {
      await api.setSystemProxy(port);
    } catch (e) {
      setError(`Proxy moved to port ${port}, but re-pointing the system proxy failed: ${e}`);
    }
  }

  // Reconcile state after a failed rebind: an atomic restart keeps the old
  // listener, but a failed stop-then-start leaves the proxy stopped — in which
  // case tear down a now-dangling system proxy too. Returns whether it survived.
  async function reconcileFailedRebind(): Promise<boolean> {
    const stillRunning = await api.proxyStatus().catch(() => false);
    setRunning(stillRunning);
    if (!stillRunning) {
      setBoundPort(null);
      setBoundAllowRemote(null);
      if (systemProxy) {
        await api.clearSystemProxy().catch(() => {});
        setSystemProxy(false);
      }
    }
    return stillRunning;
  }

  // Apply a listen-address change (port and/or the LAN-reachable scope) to the
  // running proxy. A different port uses the atomic backend restart (new port
  // bound before the old is released, so a taken port keeps the old proxy). A
  // same-port scope flip can't hold both binds at once, so it stops then starts.
  async function rebind(nextPort: number, nextAllowRemote: boolean) {
    if (busy) {
      notify("info", "Proxy is busy — try the change again in a moment.");
      return;
    }
    setBusy(true);
    setListenerError(null);
    const host = nextAllowRemote ? "0.0.0.0" : "127.0.0.1";
    const sameScopeFlip = nextPort === (boundPort ?? settings.port);
    try {
      let bound: number;
      if (sameScopeFlip) {
        // One port can't hold both the old and new bind, so release then re-bind.
        await api.stopProxy();
        bound = await api.startProxy(nextPort, nextAllowRemote);
      } else {
        bound = await api.restartProxy(nextPort, nextAllowRemote);
      }
      markBound(bound, nextAllowRemote);
      setRunning(true);
      notify("success", `Proxy listening on ${host}:${bound}`);
      await repointSystemProxy(bound);
    } catch (e) {
      const stillRunning = await reconcileFailedRebind();
      const why = friendlyError(String(e));
      const suffix = stillRunning ? " The proxy is still on its previous address." : "";
      setListenerError(`Couldn't bind ${host}:${nextPort}. ${why}${suffix}`);
    } finally {
      setBusy(false);
    }
  }

  // React to a settings save: rebind the running proxy if the listen port or the
  // LAN-reachable scope changed. Compares against the actually-bound values so
  // re-selecting the live address (after an earlier failed rebind left settings
  // ahead of reality) doesn't trigger a redundant/self-conflicting rebind.
  function applyListenChange(prev: ProxySettings, next: ProxySettings) {
    if (!running) return;
    const portChanged = next.port !== (boundPort ?? prev.port);
    const scopeChanged = next.allowRemote !== (boundAllowRemote ?? prev.allowRemote);
    if (portChanged || scopeChanged) void rebind(next.port, next.allowRemote);
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
        setBoundPort(null);
        setBoundAllowRemote(null);
        setListenerError(null);
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
        // Route at the actually-bound port, not the desired setting (they
        // diverge after a failed restart); targeting the unbound port misroutes.
        const port = running ? (boundPort ?? settings.port) : await startProxy();
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
    boundPort,
    setBoundPort,
    boundAllowRemote,
    setBoundAllowRemote,
    // The address to display: what's actually bound, falling back to the desired
    // setting before the first bind (e.g. a webview reload with a live proxy).
    listenPort: boundPort ?? settings.port,
    listenAllowRemote: boundAllowRemote ?? settings.allowRemote,
    listenerError,
    clearListenerError: () => setListenerError(null),
    systemProxy,
    busy,
    rebind,
    applyListenChange,
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
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    highlightColors: {},
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

function ruleLabelIn(ar: AutoResponderSummary, ruleId: string): string {
  for (const scenario of ar.scenarios) {
    const found = scenario.rules.find((rule) => rule.id === ruleId);
    if (found) return ruleLabel(found.matcher.url);
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
  // names / rule URLs) without taking the summary as a dependency.
  const arRef = useRef(autoresponder);
  arRef.current = autoresponder;

  const refresh = useCallback(async () => {
    try {
      setAutoresponder(await api.getAutoresponderSummary());
    } catch (e) {
      setError(String(e));
    }
  }, [setError]);

  // A rule edited/deleted in a detached window (a different source) mutates the
  // shared store directly, bypassing this window's optimistic summary updates —
  // refresh the summary so the list badge (URL/status/enabled) doesn't go stale.
  useEffect(() => {
    const self = currentWindowLabel();
    let active = true;
    let unlisten: (() => void) | undefined;
    void onRulesChanged((p) => {
      if (p.source !== self) void refresh();
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

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
            label: `Edit rule "${ruleLabel(rule.matcher.url)}"`,
            coalesceKey: `rule:${rule.id}`,
          },
        );
        setAutoresponder((current) => replaceRuleSummary(current, scenarioId, summary));
        // Tell any detached window showing this rule to reload (source-scoped so
        // this window's own listener ignores it).
        emitRulesChanged(currentWindowLabel(), rule.id);
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
      const label = `Delete rule "${ruleLabelIn(arRef.current, ruleId)}"`;
      setAutoresponder((current) => removeRuleSummary(current, scenarioId, ruleId));
      // Tell a detached window for this rule that it's gone (it shows "deleted"
      // instead of leaving a zombie editor whose every save errors).
      emitRulesChanged(currentWindowLabel(), ruleId);
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
        // Nudge any open detached rule windows to re-fetch their (reverted) rule.
        // Undo/redo can touch any rule, so signal a reload-all (ruleId = null).
        emitRulesChanged(currentWindowLabel(), null);
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
    persist("germi.columns", JSON.stringify(columnOrder));
  }, [columnOrder]);

  const visibleColumns = useMemo(
    () => resolveColumns(columnOrder, headerColumns),
    [columnOrder, headerColumns],
  );

  return { columnOrder, setColumnOrder, visibleColumns };
}

function loadShortcuts(): Bindings {
  return resolveBindings(loadJson("germi.shortcuts"));
}

function usePersistentShortcuts() {
  const [shortcuts, setShortcuts] = useState<Bindings>(loadShortcuts);
  useEffect(() => {
    persist("germi.shortcuts", JSON.stringify(shortcuts));
  }, [shortcuts]);
  return { shortcuts, setShortcuts };
}

function loadSort(): SortState | null {
  const saved = loadJson("germi.sort") as Partial<SortState> | null;
  if (
    saved &&
    typeof saved.columnId === "string" &&
    (saved.dir === "asc" || saved.dir === "desc")
  ) {
    return { columnId: saved.columnId, dir: saved.dir };
  }
  return null;
}

function useFlowSort(flows: FlowSummary[], columns: ColumnDef[]) {
  const [sort, setSort] = useState<SortState | null>(loadSort);

  useEffect(() => {
    persist("germi.sort", JSON.stringify(sort));
  }, [sort]);

  const toggleSort = useCallback((columnId: string) => {
    setSort((prev) => nextSort(prev, columnId));
  }, []);

  const resolved = useMemo(() => resolveSort(sort, columns), [sort, columns]);
  const sortedFlows = useMemo(
    () => sortFlows(flows, resolved, columns),
    [flows, resolved, columns],
  );

  return { sort: resolved, toggleSort, sortedFlows };
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
  /** Open a capture dragged from the file manager (issue #100) — same effect as
   *  `openCapture`, but the bytes come from the dropped File rather than the
   *  native picker. */
  async function openDropped(file: File, ext: CaptureExt) {
    try {
      const n = await api.openDroppedCapture(await readFileAsBase64(file), ext);
      onOpened();
      notify("success", `Opened ${plural(n, "flow")}`);
    } catch (e) {
      setError(String(e));
    }
  }
  return { saveSession, openCapture, openDropped };
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

/** The actions sitting above the bar filter + saved-filter list (issue #90):
 *  freezing the current bar/chips into a saved filter (revealing the Filters
 *  tab so the new entry is where the user lands), and the chips-row "Clear
 *  filters" that wipes everything narrowing the list — the bar AND a solo'd
 *  saved filter (the saved list itself is untouched). */
function useFilterActions(
  filtering: ReturnType<typeof useTrafficFilter>,
  savedFilters: ReturnType<typeof useSavedFilters>,
  reveal: {
    rightCollapsed: boolean;
    setRightCollapsed: (v: boolean) => void;
    setRightTab: (tab: RightTab) => void;
  },
  notify: Notify,
) {
  // matchedIds is null exactly when no bar filter is active (useFilterMatch's
  // hasFilter), so this can't drift from the pipeline's own notion of "active".
  const canSaveFilter = filtering.matchedIds !== null;

  function saveCurrentFilter() {
    if (!canSaveFilter) {
      notify("info", "Type a filter or toggle some chips first");
      return;
    }
    const created = savedFilters.addFilter(
      filtering.filter,
      [...filtering.typeChips],
      [...filtering.statusChips],
    );
    if (reveal.rightCollapsed) reveal.setRightCollapsed(false);
    reveal.setRightTab("filters");
    notify("success", `Saved filter "${savedFilterLabel(created)}"`);
  }

  function clearAllFilters() {
    filtering.resetFilter();
    savedFilters.clearSolo();
  }

  return {
    canSaveFilter,
    saveCurrentFilter,
    clearAllFilters,
    searchBusy: filtering.searching || savedFilters.soloSearching,
  };
}

/** Spawn a second, proxy-less Germi (`--viewer`) for inspecting saved captures.
 *  Works from a normal or a viewer instance (issue #71). */
function launchViewerAction(notify: Notify, setError: SetError) {
  void api
    .launchViewer()
    .then(() => notify("info", "Opening a viewer window…"))
    .catch((e) => setError(String(e)));
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
    // Pick the next selection from the VISIBLE (sorted) order, matching
    // `deleteSelected`, so a distant arrival-order flow isn't selected instead.
    nextId: nextIdAfterDelete(
      flows.map((f) => f.id),
      deleted,
      selectedId,
    ),
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
  selectedId: string | null,
  pendingSelectRef: MutableRefObject<PendingSelect>,
  notify: Notify,
  setError: SetError,
) {
  const counts = useMemo(() => countFlows(flows), [flows]);
  const deleteCaptured = () =>
    deleteCapturedAction(flows, selectedId, pendingSelectRef, notify, setError);
  return { deleteCaptured, capturedCount: counts.captured, importedCount: counts.imported };
}

function useViewState() {
  const [rightTab, setRightTabState] = useState<RightTab>(() =>
    loadString(
      "germi.rightTab",
      ["inspector", "autoresponder", "filters", "scripts"] as const,
      "inspector",
    ),
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
  const [autoLayout, setAutoLayoutState] = useState<AutoLayout>(() =>
    loadString("germi.autoLayout", ["side", "stacked"] as const, "side"),
  );
  const setAutoLayout = useCallback((layout: AutoLayout) => {
    setAutoLayoutState(layout);
    persist("germi.autoLayout", layout);
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
  const inspectorFindRef = useRef<{
    openFind: (seed?: string, scope?: "all" | "url" | "headers" | "body") => void;
    step: (dir: number) => void;
    open: boolean;
  } | null>(null);

  return {
    rightTab,
    setRightTab,
    rightMode,
    setRightMode,
    autoLayout,
    setAutoLayout,
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
    inspectorFindRef,
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
    // A trailing progress message can arrive after the command resolves (channel
    // messages aren't ordered against the response). Ignore any after completion,
    // or it would re-set the progress and permanently block further checks via the
    // guard above.
    let done = false;
    try {
      const checked = await api.checkDocAvailability(ids, (p) => {
        if (!done) setAvailabilityCheck(p);
      });
      notify(
        checked > 0 ? "success" : "info",
        checked > 0
          ? `Checked ${plural(checked, "request")} for public availability`
          : "Nothing checkable (only GET/HEAD requests are tested)",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      done = true;
      setAvailabilityCheck(null);
    }
  }

  return { checkAvailability, availabilityCheck };
}

/**
 * Detached rule-editor windows (issue #72). Tracks which rules currently have an
 * open OS window (so the inline editor can lock those rules) and coordinates
 * cross-window freshness: a save in any window re-fetches the summary here, and a
 * closing window drops out of the set. `activeScenarioId` is the only place a
 * rule id maps to its scenario for the save path.
 */
function useRuleWindows(
  ar: AutoResponderSummary,
  refresh: () => Promise<void>,
  setError: SetError,
) {
  const [openRuleWindows, setOpenRuleWindows] = useState<Set<string>>(() => new Set());
  const arRef = useRef(ar);
  arRef.current = ar;

  useEffect(() => {
    let active = true;
    // Recover windows that outlived a main-window reload.
    void listOpenRuleIds()
      .then((ids) => {
        if (active && ids.length) setOpenRuleWindows(new Set(ids));
      })
      .catch(() => {});
    const listeners = [
      onRulesChanged((p) => {
        if (p.source === currentWindowLabel()) return;
        void refresh();
      }),
      onRuleWindowClosed((p) => {
        setOpenRuleWindows((prev) => {
          if (!prev.has(p.ruleId)) return prev;
          const next = new Set(prev);
          next.delete(p.ruleId);
          return next;
        });
        void refresh();
      }),
      onRuleWindowResized((size) => saveRuleWindowSize(size)),
    ];
    return () => {
      active = false;
      for (const l of listeners) void l.then((un) => un());
    };
  }, [refresh]);

  const openRuleWindow = useCallback(
    (ruleId: string) => {
      const scenarioId = arRef.current.activeScenarioId;
      if (!scenarioId) return;
      const rule = arRef.current.scenarios
        .find((s) => s.id === scenarioId)
        ?.rules.find((r) => r.id === ruleId);
      const title = rule ? ruleLabel(rule.matcher.url) : "Rule";
      setOpenRuleWindows((prev) => (prev.has(ruleId) ? prev : new Set(prev).add(ruleId)));
      void openOrFocusRuleWindow(ruleId, scenarioId, title).catch((e) => {
        setOpenRuleWindows((prev) => {
          const next = new Set(prev);
          next.delete(ruleId);
          return next;
        });
        setError(String(e));
      });
    },
    [setError],
  );

  return { openRuleWindows, openRuleWindow };
}

// Viewer mode (`--viewer`, issue #71): a proxy-less inspector instance. Held as
// a feature hook so the composition root just wires `viewer` into the proxy-
// dependent bits (Toolbar controls, capture-on-start, the system-proxy hotkey).
function useViewerMode(notify: Notify, setError: SetError) {
  const [viewer, setViewer] = useState(false);
  const launchViewer = () => launchViewerAction(notify, setError);
  return { viewer, setViewer, launchViewer };
}

/** Open (or focus + re-seed) the compare window (issue #86) from the current
 *  selection: exactly two selected rows prefill both sides — one Enter from a
 *  diff — otherwise everything selected lands on the left. The seed travels
 *  through the backend mailbox (`set_compare_seed`), so a select-all seed
 *  never hits URL-length limits and survives a compare-window reload. */
function useCompare(selectedSummaries: FlowSummary[], notify: Notify) {
  // Ref-read so openCompare snapshots the selection at call time, not at the
  // render that created the callback.
  const selectedRef = useRef(selectedSummaries);
  selectedRef.current = selectedSummaries;

  function openCompare() {
    const selected = selectedRef.current;
    if (selected.length === 0) {
      notify("info", "Select one or more requests to compare first");
      return;
    }
    const ids = selected.map((f) => f.id);
    const seed =
      selected.length === 2 ? { left: [ids[0]], right: [ids[1]] } : { left: ids, right: [] };
    void api
      .setCompareSeed(seed)
      .then(openOrFocusCompareWindow)
      .catch((e) => notify("error", String(e)));
  }

  return { openCompare };
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
    autoLayout,
    setAutoLayout,
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
    inspectorFindRef,
  } = useViewState();
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);
  const { viewer, setViewer, launchViewer } = useViewerMode(notify, setError);

  const settings = useSettings();
  const flowStore = useFlowStore(setError);
  const columns = usePersistentColumns(settings.settings.headerColumns);
  const { sort, toggleSort, sortedFlows } = useFlowSort(flowStore.flows, columns.visibleColumns);
  const filtering = useTrafficFilter(sortedFlows, setError);
  const savedFilters = useSavedFilters(sortedFlows, filtering.matchedIds, setError);
  const filterActions = useFilterActions(
    filtering,
    savedFilters,
    { rightCollapsed, setRightCollapsed, setRightTab },
    notify,
  );
  const selection = useSelection(savedFilters.visibleFlows);
  const selectedSummary = selection.selectedId
    ? flowStore.flowsRef.current.get(selection.selectedId)
    : undefined;
  const selectedSummaries = useMemo(
    () => sortedFlows.filter((f) => selection.selectedIds.has(f.id)),
    [sortedFlows, selection.selectedIds],
  );
  const inspector = useFlowDetail(selection.selectedId, decode, fullBody, selectedSummary);
  const availability = useAvailabilityCheck(
    sortedFlows,
    selection.selectedIds,
    savedFilters.combinedMatchedIds,
    notify,
    setError,
  );
  const compare = useCompare(selectedSummaries, notify);

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
    // Reset the full-body flag as handleKeySelect would; this deferred reselect
    // bypasses it, so without this the next flow would be fetched uncapped.
    setFullBody(false);
    if (pending.nextId === null || !order.includes(pending.nextId)) {
      selection.clearSelection();
      inspector.setDetail(null);
    } else {
      selection.selectByKeyboard(pending.nextId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowStore.flows]);

  const captured = useCapturedDelete(
    sortedFlows,
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
  useSystemHotkeys(
    settings.settings.systemProxyHotkey,
    proxy.toggleSystemProxyHotkey,
    setError,
    !viewer,
  );
  useProxyIndicator(proxy.systemProxy);
  const autoresponderActive = !viewer && (rightTab === "autoresponder" || rightMode === "split");
  const ar = useAutoresponder(setError, setRightTab, notify, autoresponderActive);
  const ruleWindows = useRuleWindows(ar.autoresponder, ar.refresh, setError);
  const history = useHistory(ar.refresh, setError);
  const shortcuts = usePersistentShortcuts();
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
      setBoundPort: proxy.setBoundPort,
      setBoundAllowRemote: proxy.setBoundAllowRemote,
      setViewer,
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
    const prev = settings.settings;
    settings.setSettings(next);
    persistSettings(next, prev.headerColumns, flowStore.refresh, setError);
    proxy.applyListenChange(prev, next);
  }

  function applyImportedSettings(next: ProxySettings) {
    const prev = settings.settings;
    const headersChanged = !isEqual(next.headerColumns, prev.headerColumns);
    settings.setSettings(next);
    // The import command already persisted; windows just need to re-read.
    emitSettingsChanged();
    if (headersChanged) void flowStore.refresh().catch((e) => setError(String(e)));
    // Rebind the running proxy if the imported file changed the port/scope, the
    // same as an in-app settings change — otherwise the field shows the new port
    // while traffic still flows through the old one.
    proxy.applyListenChange(prev, next);
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
    const matched = savedFilters.combinedMatchedIds;
    const visible = savedFilters.visibleFlows;
    const ids = matched
      ? visible.filter((f) => matched.has(f.id)).map((f) => f.id)
      : visible.map((f) => f.id);
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

  // A capture dropped onto the main window shares the open-capture confirm
  // (replacing traffic is destructive and never auto-saved). The dropped File
  // parks here until the user confirms; `null` means the confirm belongs to the
  // native picker instead (issue #100).
  const pendingDropRef = useRef<{ file: File; ext: CaptureExt } | null>(null);

  function requestOpenCapture() {
    if (flowStore.orderRef.current.length === 0) {
      void session.openCapture();
      return;
    }
    setConfirmOpen(true);
  }

  function requestOpenDropped(file: File, ext: CaptureExt) {
    if (flowStore.orderRef.current.length === 0) {
      void session.openDropped(file, ext);
      return;
    }
    pendingDropRef.current = { file, ext };
    setConfirmOpen(true);
  }

  function confirmOpenCapture() {
    setConfirmOpen(false);
    const dropped = pendingDropRef.current;
    pendingDropRef.current = null;
    if (dropped) {
      void session.openDropped(dropped.file, dropped.ext);
      return;
    }
    void session.openCapture();
  }

  function cancelOpenCapture() {
    pendingDropRef.current = null;
    setConfirmOpen(false);
  }

  // Prune the selected flows (no confirm — the backend `removed` event drops
  // the rows). The actual selection move is deferred until those rows are gone
  // (see pendingSelectRef effect above), so the highlight transfer and the row
  // removal happen in one frame instead of two (issue #4).
  function deleteSelected() {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const nextId = nextIdAfterDelete(
      savedFilters.visibleFlows.map((f) => f.id),
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

  const matchCount = savedFilters.combinedMatchedIds?.size ?? null;

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
    autoLayout,
    setAutoLayout,
    openRuleWindows: ruleWindows.openRuleWindows,
    openRuleWindow: ruleWindows.openRuleWindow,
    decode,
    setDecode,
    setFullBody,
    caInfo,
    caOpen,
    setCaOpen,
    rightCollapsed,
    setRightCollapsed,
    filterInputRef,
    inspectorFindRef,
    confirmClear,
    setConfirmClear,
    requestClearTraffic,
    confirmClearTraffic,
    confirmOpen,
    setConfirmOpen,
    requestOpenCapture,
    requestOpenDropped,
    confirmOpenCapture,
    cancelOpenCapture,
    settings,
    flowStore,
    flows: savedFilters.visibleFlows,
    sort,
    toggleSort,
    filtering,
    savedFilters,
    ...filterActions,
    selection,
    selectedSummary,
    selectedSummaries,
    selectAllVisible,
    inspector,
    proxy,
    ar,
    history,
    columns,
    shortcuts: shortcuts.shortcuts,
    setShortcuts: shortcuts.setShortcuts,
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
    openCompare: compare.openCompare,
    focusMockBody,
    clearTraffic,
    deleteSelected,
    deleteCaptured: captured.deleteCaptured,
    capturedCount: captured.capturedCount,
    importedCount: captured.importedCount,
    refreshCa,
    activeScenario,
    matchCount,
    viewer,
    launchViewer,
  };
}
