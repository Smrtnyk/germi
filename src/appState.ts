import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { compact, isEqual } from "es-toolkit";

import { announce } from "./announce";
import { api, subscribeFlows } from "./ipc";
import { openOrFocusCompareWindow } from "./compareWindow";
import {
  currentRuleWindowLabel,
  emitRulesChanged,
  flushDetachedRuleWindows,
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
import { useAsyncSubscription } from "./useTauriListen";
import { friendlyError, useToasts, type Notify } from "./toast";
import { toCurl } from "./curl";
import { copyText } from "./useCopy";
import { flowUrl } from "./flowUrl";
import { focusMockResponseBody } from "./focusMockBody";
import {
  capturedDeletePlan,
  nextIdAfterDelete,
  rangeSelection,
  toggleSelection,
} from "./selection";
import { resolveBindings, type Bindings } from "./shortcuts";
import { emitSettingsChanged } from "./themeSync";
import { OrderedTaskQueue } from "./orderedTaskQueue";
import { readFileAsBase64 } from "./captureDrop";
import type { CaptureExt } from "./dnd";
import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  insertRuleSummaryAfter,
  mockingRuleCount,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
  ruleLabel,
  type RuleSeed,
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
  OpenedCapture,
  ProxySettings,
  Rule,
  RuleSummary,
  ScenarioPreview,
  ScenarioSummary,
} from "./types";

export type RightTab = "inspector" | "autoresponder" | "filters" | "scripts";
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

async function persistSettings(
  next: ProxySettings,
  prevHeaderColumns: string[],
  refresh: () => Promise<void>,
  setError: SetError,
): Promise<void> {
  const headersChanged = !isEqual(next.headerColumns, prevHeaderColumns);
  await api.setSettings(next);
  emitSettingsChanged();
  if (headersChanged) {
    try {
      await refresh();
    } catch (error) {
      // Persistence already succeeded; a traffic refresh failure must be
      // reported without pretending the settings write itself rolled back.
      setError(String(error));
    }
  }
}

interface InitialStateOptions {
  setRunning: (running: boolean) => void;
  setBoundPort: (port: number) => void;
  setBoundAllowRemote: (allowRemote: boolean) => void;
  setSystemProxy: (active: boolean) => void;
  setViewer: (viewer: boolean) => void;
  loadAutoresponder: () => Promise<void>;
  setSettings: (s: ProxySettings) => void;
  setDurableSettings: (s: ProxySettings) => void;
  setSettingsReady: () => void;
  getSettingsMutationGeneration: () => number;
  getLatestSettings: () => ProxySettings;
  getCaMutationGeneration: () => number;
  getProxyOperationGeneration: () => number;
  serializeProxyOperation: (operation: () => Promise<void>) => Promise<void>;
  flushSettingsSaves: () => Promise<void>;
  reconcileListenerSettings: (previous: ProxySettings) => Promise<void>;
  onPortBound: (port: number) => void;
  setCaInfo: (ca: CaInfo) => void;
  loadInitialFlows: () => Promise<void>;
  setError: SetError;
}

async function disableOwnedSystemProxy(
  opts: InitialStateOptions,
  successMessage: string | null,
  failureMessage: string,
): Promise<void> {
  try {
    await api.clearSystemProxy();
    opts.setSystemProxy(false);
    if (successMessage) opts.setError(successMessage);
  } catch (error) {
    opts.setSystemProxy(true);
    opts.setError(`${failureMessage}: ${error}`);
  }
}

async function reconcileInitialSystemProxy(
  opts: InitialStateOptions,
  viewer: boolean,
): Promise<void> {
  if (viewer) return;
  const system = await api.systemProxyStatus();
  if (!system.active) return;
  if (!(await api.proxyStatus())) {
    await disableOwnedSystemProxy(
      opts,
      null,
      "The system proxy still points at Germi, but its listener is stopped",
    );
    return;
  }
  const addr = await api.boundAddr();
  if (!addr) {
    await disableOwnedSystemProxy(
      opts,
      null,
      "The system proxy still points at Germi, but its running listener has no bound address",
    );
    return;
  }
  if (system.port === addr.port) {
    opts.setSystemProxy(true);
    return;
  }
  try {
    await api.setSystemProxy(addr.port);
    opts.setSystemProxy(true);
  } catch (repointError) {
    await disableOwnedSystemProxy(
      opts,
      `The listener is on port ${addr.port}, but the system proxy could not be re-pointed ` +
        `and was disabled instead: ${repointError}`,
      `Urgent: the system proxy points at a different port than Germi's listener. ` +
        `Re-pointing failed (${repointError}); restoring it failed`,
    );
  }
}

async function loadDurableSettings(
  opts: InitialStateOptions,
  settingsGeneration: number,
): Promise<ProxySettings> {
  const loaded = await api.getSettings();
  if (opts.getSettingsMutationGeneration() === settingsGeneration) {
    opts.setDurableSettings(loaded);
    opts.setSettings(loaded);
  }
  opts.setSettingsReady();
  return loaded;
}

async function restoreRunningProxyState(
  opts: InitialStateOptions,
  loadedSettings: ProxySettings,
  running: boolean,
  proxyGeneration: number,
): Promise<void> {
  if (!running || opts.getProxyOperationGeneration() !== proxyGeneration) return;

  const addr = await api.boundAddr();
  if (!addr || opts.getProxyOperationGeneration() !== proxyGeneration) return;

  opts.setBoundPort(addr.port);
  opts.setBoundAllowRemote(addr.allowRemote);
  // Settings becomes editable before the remaining startup probes finish. If a
  // fast save landed while running was still unknown, its ordinary listener
  // reconciliation returned early. Reconcile after the actual address is known.
  await opts.flushSettingsSaves();
  if (opts.getProxyOperationGeneration() === proxyGeneration) {
    await opts.reconcileListenerSettings(loadedSettings);
  }
}

async function reportInitialLoadError(
  opts: InitialStateOptions,
  load: () => Promise<void>,
): Promise<void> {
  try {
    await load();
  } catch (error) {
    opts.setError(String(error));
  }
}

async function loadInitialCaInfo(opts: InitialStateOptions): Promise<void> {
  const generation = opts.getCaMutationGeneration();
  const ca = await api.caInfo();
  if (generation === opts.getCaMutationGeneration()) opts.setCaInfo(ca);
}

async function loadIndependentInitialPanels(opts: InitialStateOptions): Promise<void> {
  // These panels are independent of listener/system-proxy ownership. Report a
  // failed hydration but continue through the safety-critical reconciliation.
  await reportInitialLoadError(opts, opts.loadAutoresponder);
  await reportInitialLoadError(opts, () => loadInitialCaInfo(opts));
  await reportInitialLoadError(opts, opts.loadInitialFlows);
}

async function autoStartInitialProxy(
  opts: InitialStateOptions,
  viewer: boolean,
  running: boolean,
  proxyGeneration: number,
): Promise<void> {
  if (running || viewer || opts.getProxyOperationGeneration() !== proxyGeneration) return;

  // A harmless edit while the other startup reads were in flight must not
  // cancel auto-start. Wait for it and bind from the latest durable value.
  await opts.flushSettingsSaves();
  const startupSettings = opts.getLatestSettings();
  const settingsGeneration = opts.getSettingsMutationGeneration();
  if (!startupSettings.autoStartOnLaunch) return;

  try {
    const boundPort = await api.startProxy(startupSettings.port, startupSettings.allowRemote);
    opts.setBoundPort(boundPort);
    opts.setBoundAllowRemote(startupSettings.allowRemote);
    opts.setRunning(true);
    if (boundPort !== startupSettings.port) opts.onPortBound(boundPort);
    // A save may have begun while startProxy awaited the bind. Reconcile from
    // the address that actually started once that save has settled.
    if (opts.getSettingsMutationGeneration() !== settingsGeneration) {
      await opts.flushSettingsSaves();
      await opts.reconcileListenerSettings(startupSettings);
    }
  } catch (error) {
    opts.setError(
      `Couldn't auto-start the proxy on port ${startupSettings.port} (${error}). ` +
        `Change the port in Settings → Connections, then press Start.`,
    );
  }
}

async function loadInitialState(opts: InitialStateOptions): Promise<boolean> {
  // Retain a generation guard for non-dialog startup mutations (for example an
  // auto-start bind choosing a different port). The Settings UI itself remains
  // gated until its durable snapshot has loaded.
  const settingsGeneration = opts.getSettingsMutationGeneration();
  const proxyGeneration = opts.getProxyOperationGeneration();
  try {
    // Hydrate the only full-snapshot editor first. Failures in unrelated proxy,
    // CA, or autoresponder startup must not leave Settings permanently gated.
    const loaded = await loadDurableSettings(opts, settingsGeneration);

    const viewer = await api.isViewerMode();
    opts.setViewer(viewer);
    const isRunning = await api.proxyStatus();
    if (opts.getProxyOperationGeneration() === proxyGeneration) opts.setRunning(isRunning);
    // If the proxy is already up (e.g. the webview reloaded while the Rust proxy
    // kept running), re-read the real bound address so the status bar and the
    // system-proxy target reflect reality, not the persisted (maybe-drifted) port.
    await restoreRunningProxyState(opts, loaded, isRunning, proxyGeneration);
    await loadIndependentInitialPanels(opts);
    // Never auto-start the proxy in a viewer instance — it has no proxy to run.
    await autoStartInitialProxy(opts, viewer, isRunning, proxyGeneration);
    // Serialize reconciliation with settings-driven listener rebinds. Anything
    // already queued finishes first; anything queued later sees ownership set
    // here and therefore re-points the OS proxy after moving the listener.
    await opts.serializeProxyOperation(() => reconcileInitialSystemProxy(opts, viewer));
    return true;
  } catch (e) {
    opts.setError(String(e));
    // A settings/viewer/proxy-ownership probe failed. Keep listener controls and
    // the global hotkey gated: acting from default or unknown state could stop a
    // listener without restoring an OS proxy that still points at it.
    return false;
  }
}

function useFlowStore(setError: SetError, mutationQueue: OrderedTaskQueue) {
  const RECONCILE_RETRY_MIN_MS = 250;
  const RECONCILE_RETRY_MAX_MS = 5_000;
  const flowsRef = useRef<Map<string, FlowSummary>>(new Map());
  const orderRef = useRef<string[]>([]);
  const pendingRef = useRef<FlowEvent[][]>([]);
  const reconciliationRef = useRef<Promise<void> | null>(null);
  const resyncNeededRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const retryDelayRef = useRef(RECONCILE_RETRY_MIN_MS);
  const reconcileErrorReportedRef = useRef(false);
  const mountedRef = useRef(true);
  const subscriptionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const subscriptionStateRef = useRef<"idle" | "pending" | "ready" | "failed">("idle");
  const subscriptionRef = useRef<ReturnType<typeof subscribeFlows> | null>(null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  function handleFlowEvents(events: FlowEvent[]) {
    if (reconciliationRef.current) {
      pendingRef.current.push(events);
      return;
    }
    if (resyncNeededRef.current) {
      resyncNeededRef.current = false;
      pendingRef.current.push(events);
      void reconcile();
      return;
    }
    const resync = applyFlowEvents(flowsRef.current, orderRef.current, events);
    bump();
    if (resync) void reconcile();
  }

  function installSubscription() {
    if (subscriptionRef.current) subscriptionRef.current.channel.onmessage = () => {};
    const subscription = subscribeFlows(handleFlowEvents);
    subscriptionRef.current = subscription;
    subscriptionReadyRef.current = subscription.ready;
    subscriptionStateRef.current = "pending";
    void subscription.ready.then(
      () => {
        if (subscriptionRef.current === subscription) subscriptionStateRef.current = "ready";
      },
      () => {
        if (subscriptionRef.current === subscription) subscriptionStateRef.current = "failed";
      },
    );
    return subscription;
  }

  function scheduleReconcileRetry() {
    if (!mountedRef.current || retryTimerRef.current !== null) return;
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(delay * 2, RECONCILE_RETRY_MAX_MS);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (mountedRef.current) void reconcile();
    }, delay);
  }

  function drainPendingFlowEvents(): boolean {
    let resync = false;
    for (let batch = pendingRef.current.shift(); batch; batch = pendingRef.current.shift()) {
      if (applyFlowEvents(flowsRef.current, orderRef.current, batch)) resync = true;
    }
    return resync;
  }

  async function loadStableFlowSnapshot(): Promise<void> {
    for (;;) {
      const ready = subscriptionReadyRef.current;
      await ready;
      // React Strict Mode can replace the subscription while its first
      // readiness promise or snapshot is in flight. Only accept a snapshot
      // bracketed by the same installed channel.
      if (ready !== subscriptionReadyRef.current) continue;
      const fresh = await api.listFlows();
      if (ready !== subscriptionReadyRef.current) continue;
      rebuildFromSnapshot(flowsRef.current, orderRef.current, fresh);
      if (!drainPendingFlowEvents()) return;
    }
  }

  function prepareFlowReconciliation(): void {
    // A failed channel installation is not healed by re-awaiting the same
    // rejected promise. A list-only failure keeps its working subscriber.
    if (subscriptionStateRef.current === "idle" || subscriptionStateRef.current === "failed") {
      installSubscription();
    }
    resyncNeededRef.current = false;
  }

  function handleFlowReconcileError(error: unknown): void {
    // A transient list failure must not discard events that arrived while it
    // was in flight. Keep a lag marker even if no batch requested a resync.
    resyncNeededRef.current = true;
    drainPendingFlowEvents();
    // Backoff retries should not create an unbounded stack of identical toasts.
    if (!reconcileErrorReportedRef.current) {
      reconcileErrorReportedRef.current = true;
      setError(String(error));
    }
    scheduleReconcileRetry();
  }

  function reconcile(): Promise<void> {
    const active = reconciliationRef.current;
    if (active) return active;

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const run = (async () => {
      try {
        prepareFlowReconciliation();
        // The first snapshot must start only after the backend installed the
        // channel. Otherwise a flow captured between listFlows and subscribe
        // can be absent from both the snapshot and the event stream.
        await loadStableFlowSnapshot();
        retryDelayRef.current = RECONCILE_RETRY_MIN_MS;
        reconcileErrorReportedRef.current = false;
      } catch (error) {
        handleFlowReconcileError(error);
      } finally {
        if (mountedRef.current) bump();
      }
    })();
    reconciliationRef.current = run;
    void run.finally(() => {
      if (reconciliationRef.current === run) reconciliationRef.current = null;
    });
    return run;
  }

  useEffect(() => {
    mountedRef.current = true;
    // Batches that arrive while any authoritative re-list is in flight are
    // replayed on top of that snapshot. This applies to startup and manual
    // refresh too, not only explicit resync events.
    installSubscription();
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (subscriptionRef.current) subscriptionRef.current.channel.onmessage = () => {};
      subscriptionRef.current = null;
      subscriptionStateRef.current = "idle";
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
    void mutationQueue
      .run(() => api.setFlowComment(id, comment))
      .catch(async (e) => {
        setError(String(e));
        // The local row is optimistic. Re-list only after later queued
        // mutations have settled, so an IPC/persistence failure cannot leave an
        // unsaved comment displayed or overwrite a newer edit while repairing
        // this one.
        await mutationQueue.flush();
        await reconcile();
      });
  }

  async function loadInitial() {
    await reconcile();
  }

  async function refresh() {
    await reconcile();
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
  interactiveEnabled: boolean,
) {
  const [running, setRunningState] = useState(false);
  const [systemProxy, setSystemProxyState] = useState(false);
  const [busy, setBusyState] = useState(false);
  // What the proxy is ACTUALLY bound to; diverges from settings after a failed
  // restart, so the status bar and system-proxy target read this, not the
  // pending setting (otherwise the UI would claim a host/port that isn't live).
  const [boundPort, setBoundPortState] = useState<number | null>(null);
  const [boundAllowRemote, setBoundAllowRemoteState] = useState<boolean | null>(null);
  // Last rebind failure, shown inline in Settings → Connections (a toast is
  // hidden behind the settings modal, which is where port changes come from).
  const [listenerError, setListenerError] = useState<string | null>(null);

  // Settings saves and toolbar/hotkey actions finish asynchronously. React
  // closures from the render that queued them can be stale by the time they run,
  // so operational decisions read synchronously-updated refs rather than a past
  // render's listener/ownership state.
  const liveRef = useRef({ running, systemProxy, boundPort, boundAllowRemote });
  liveRef.current = { running, systemProxy, boundPort, boundAllowRemote };

  function setRunning(value: boolean) {
    liveRef.current.running = value;
    setRunningState(value);
  }

  function setSystemProxy(value: boolean) {
    liveRef.current.systemProxy = value;
    setSystemProxyState(value);
  }

  function setBoundPort(value: number | null) {
    liveRef.current.boundPort = value;
    setBoundPortState(value);
  }

  function setBoundAllowRemote(value: boolean | null) {
    liveRef.current.boundAllowRemote = value;
    setBoundAllowRemoteState(value);
  }

  const operationQueueRef = useRef<OrderedTaskQueue | null>(null);
  operationQueueRef.current ??= new OrderedTaskQueue();
  const operationQueue = operationQueueRef.current;
  const operationCountRef = useRef(0);
  const operationGenerationRef = useRef(0);

  /** Serialize listener/system-proxy transitions. Settings rebinds wait their
   * turn; duplicate interactive clicks are ignored while one is pending. */
  function runProxyOperation(operation: () => Promise<void>, dropIfBusy: boolean): Promise<void> {
    if (dropIfBusy && (!interactiveEnabled || operationCountRef.current > 0)) {
      return Promise.resolve();
    }
    operationGenerationRef.current += 1;
    operationCountRef.current += 1;
    setBusyState(true);
    const run = operationQueue.run(operation);
    return run.finally(() => {
      operationCountRef.current -= 1;
      if (operationCountRef.current === 0) setBusyState(false);
    });
  }

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

  // Reconcile state after a failed rebind: an atomic restart keeps the old
  // listener, but a failed stop-then-start leaves the proxy stopped. Always try
  // the prior listener first; only disable a dangling system proxy when that
  // recovery also fails. Returns whether a listener survived.
  async function reconcileFailedRebind(
    previousPort: number,
    previousAllowRemote: boolean,
  ): Promise<boolean> {
    const stillRunning = await api.proxyStatus().catch(() => false);
    setRunning(stillRunning);
    if (!stillRunning) {
      try {
        const restoredPort = await api.startProxy(previousPort, previousAllowRemote);
        markBound(restoredPort, previousAllowRemote);
        setRunning(true);
        return true;
      } catch (restartError) {
        if (!liveRef.current.systemProxy) {
          setError(
            `Changing the listener failed and Germi could not restart the previous listener ` +
              `on port ${previousPort} (${restartError}).`,
          );
        } else {
          try {
            await api.clearSystemProxy();
            setSystemProxy(false);
            setError(
              `Changing the listener failed and Germi could not restart the previous listener ` +
                `on port ${previousPort} (${restartError}). The system proxy was disabled to keep traffic online.`,
            );
          } catch (clearError) {
            setError(
              `Urgent: the system proxy still points at Germi but no listener is running. ` +
                `Restarting the old listener failed (${restartError}); restoring the OS proxy failed (${clearError}).`,
            );
          }
        }
      }
      setBoundPort(null);
      setBoundAllowRemote(null);
    }
    return stillRunning;
  }

  async function recoverRepointFailure(
    bound: number,
    nextAllowRemote: boolean,
    host: string,
    previousPort: number,
    previousAllowRemote: boolean,
    repointError: unknown,
  ): Promise<void> {
    const actual = await api.systemProxyStatus().catch(() => null);
    if (actual?.active && actual.port === bound) {
      markBound(bound, nextAllowRemote);
      setRunning(true);
      setError(`The OS reported an error while moving its proxy, but it now targets ${bound}.`);
      return;
    }

    let rollbackError: unknown;
    try {
      const restored = await api.restartProxy(previousPort, previousAllowRemote);
      markBound(restored, previousAllowRemote);
      setRunning(true);
      if (actual?.active === false) {
        // The OS proxy was replaced externally while the re-point was in flight.
        // The backend has dropped ownership; mirror that instead of leaving a
        // stale on-toggle after successfully restoring the old listener.
        setSystemProxy(false);
        setListenerError(
          `The listener moved to ${host}:${bound}, but the system proxy is no longer owned by ` +
            `Germi. The previous listener was restored on port ${restored}.`,
        );
      } else {
        setListenerError(
          `The listener moved to ${host}:${bound}, but the system proxy could not follow ` +
            `(${repointError}). Germi restored the previous listener on port ${restored}.`,
        );
      }
      return;
    } catch (error) {
      rollbackError = error;
    }

    markBound(bound, nextAllowRemote);
    setRunning(true);
    try {
      await api.clearSystemProxy();
      setSystemProxy(false);
      setListenerError(
        `The listener moved to ${host}:${bound}, but the system proxy could not follow ` +
          `and was disabled. Restoring the old listener also failed (${rollbackError}).`,
      );
    } catch (clearError) {
      setError(
        `Urgent: the system proxy may point at the stopped port ${previousPort}. ` +
          `Re-pointing failed (${repointError}); restoring the listener failed ` +
          `(${rollbackError}); restoring the OS proxy failed (${clearError}).`,
      );
    }
  }

  // Apply a listen-address change (port and/or the LAN-reachable scope) to the
  // running proxy. The backend handles overlapping same-port scope flips by
  // restoring the old listener if the replacement bind fails; routing every
  // rebind through it keeps that rollback atomic from the webview's perspective.
  async function rebind(nextPort: number, nextAllowRemote: boolean) {
    await runProxyOperation(async () => {
      // A Stop action may have run before this queued settings rebind. Keep the
      // new setting for the next Start instead of unexpectedly starting again.
      if (!liveRef.current.running) return;
      setListenerError(null);
      const host = nextAllowRemote ? "0.0.0.0" : "127.0.0.1";
      const previousPort = liveRef.current.boundPort ?? settings.port;
      const previousAllowRemote = liveRef.current.boundAllowRemote ?? settings.allowRemote;
      try {
        const bound = await api.restartProxy(nextPort, nextAllowRemote);

        if (liveRef.current.systemProxy && bound !== previousPort) {
          try {
            await api.setSystemProxy(bound);
          } catch (repointError) {
            await recoverRepointFailure(
              bound,
              nextAllowRemote,
              host,
              previousPort,
              previousAllowRemote,
              repointError,
            );
            return;
          }
        }
        markBound(bound, nextAllowRemote);
        setRunning(true);
        notify("success", `Proxy listening on ${host}:${bound}`);
      } catch (e) {
        const stillRunning = await reconcileFailedRebind(previousPort, previousAllowRemote);
        const why = friendlyError(String(e));
        const suffix = stillRunning ? " The proxy is still on its previous address." : "";
        setListenerError(`Couldn't bind ${host}:${nextPort}. ${why}${suffix}`);
      }
    }, false);
  }

  // React to a settings save: rebind the running proxy if the listen port or the
  // LAN-reachable scope changed. Compares against the actually-bound values so
  // re-selecting the live address (after an earlier failed rebind left settings
  // ahead of reality) doesn't trigger a redundant/self-conflicting rebind.
  async function applyListenChange(prev: ProxySettings, next: ProxySettings): Promise<void> {
    if (!liveRef.current.running) return;
    const portChanged = next.port !== (liveRef.current.boundPort ?? prev.port);
    const scopeChanged =
      next.allowRemote !== (liveRef.current.boundAllowRemote ?? prev.allowRemote);
    if (portChanged || scopeChanged) await rebind(next.port, next.allowRemote);
  }

  async function toggleProxy() {
    await runProxyOperation(async () => {
      try {
        if (liveRef.current.running) {
          if (liveRef.current.systemProxy) {
            await api.clearSystemProxy();
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
      }
    }, true);
  }

  async function toggleSystemProxyWith(report: (message: string) => void) {
    await runProxyOperation(async () => {
      const enabling = !liveRef.current.systemProxy;
      try {
        if (!enabling) {
          await api.clearSystemProxy();
          setSystemProxy(false);
          report("System proxy off");
        } else {
          // Route at the actually-bound port, not the desired setting (they
          // diverge after a failed restart); targeting the unbound port misroutes.
          const port = liveRef.current.running
            ? (liveRef.current.boundPort ?? settings.port)
            : await startProxy();
          await api.setSystemProxy(port);
          setSystemProxy(true);
          report("System proxy on — routed through Germi");
        }
      } catch (e) {
        // Platform proxy APIs can report failure after applying the change. The
        // backend performs its own read-back, but if that read also failed, a
        // second status attempt here keeps the toggle aligned once the platform
        // becomes readable again. Its crash journal still protects shutdown if
        // this retry remains ambiguous.
        const actual = await api.systemProxyStatus().catch(() => null);
        if (actual) setSystemProxy(actual.active);
        setError(String(e));
      }
    }, true);
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
    setSystemProxy,
    busy: busy || !interactiveEnabled,
    getOperationGeneration: () => operationGenerationRef.current,
    serializeOperation: (operation: () => Promise<void>) => runProxyOperation(operation, false),
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
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let errorReported = false;
    const poll = () => {
      const generation = ++requestGenerationRef.current;
      void api
        .ruleHits()
        .then((h) => {
          if (!cancelled && generation === requestGenerationRef.current) {
            errorReported = false;
            setRuleHits(h);
          }
        })
        .catch((error) => {
          if (!cancelled && generation === requestGenerationRef.current && !errorReported) {
            errorReported = true;
            setError(String(error));
          }
        });
    };
    poll();
    const interval = active ? window.setInterval(poll, 1500) : null;
    return () => {
      cancelled = true;
      requestGenerationRef.current += 1;
      if (interval !== null) clearInterval(interval);
    };
  }, [activeScenarioId, active, setError]);

  function resetRuleState(scenarioId: string | null) {
    requestGenerationRef.current += 1;
    void api
      .resetRuleState(scenarioId)
      .then(async () => {
        // A poll started while reset was awaiting is older than this post-reset
        // read, even if its IPC response happens to arrive later.
        const readGeneration = ++requestGenerationRef.current;
        const hits = await api.ruleHits();
        if (readGeneration === requestGenerationRef.current) setRuleHits(hits);
      })
      .catch((error) => setError(String(error)));
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

function useRuleSeedState() {
  const [ruleSeed, setRuleSeed] = useState<RuleSeed | null>(null);
  const consumeRuleSeed = useCallback(() => setRuleSeed(null), []);
  return { ruleSeed, setRuleSeed, consumeRuleSeed };
}

function useAutoresponderStore(setError: SetError, mutationQueue: OrderedTaskQueue) {
  const [autoresponder, setAutoresponderState] = useState<AutoResponderSummary>({
    scenarios: [],
    activeScenarioId: null,
    generalActive: true,
  });
  const refreshGenerationRef = useRef(0);
  const refreshRequestGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const setAutoresponder = useCallback((next: SetStateAction<AutoResponderSummary>) => {
    // Local/optimistic mutations and accepted snapshots share one generation.
    // Any state committed after a refresh started makes that older response
    // ineligible to overwrite the newer UI/backend intent.
    refreshGenerationRef.current += 1;
    setAutoresponderState(next);
  }, []);
  const trackMutation = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> => {
      // A queued backend mutation is newer than any summary snapshot already
      // in flight, even when it has no optimistic UI update of its own
      // (create/import). Serialize factories rather than already-started
      // promises so click order is also durable transaction order.
      refreshGenerationRef.current += 1;
      return mutationQueue.run(operation);
    },
    [mutationQueue],
  );

  // Latest summary in a ref so actions can build human history labels (scenario
  // names / rule URLs) without taking the summary as a dependency.
  const arRef = useRef(autoresponder);
  arRef.current = autoresponder;
  const getAutoresponder = useCallback(() => arRef.current, []);

  const refresh = useCallback((): Promise<void> => {
    refreshRequestGenerationRef.current += 1;
    const active = refreshInFlightRef.current;
    if (active) return active;

    const run = (async () => {
      try {
        for (;;) {
          await mutationQueue.flush();
          const generation = refreshGenerationRef.current;
          const requestGeneration = refreshRequestGenerationRef.current;
          const loaded = await api.getAutoresponderSummary();
          if (
            generation !== refreshGenerationRef.current ||
            requestGeneration !== refreshRequestGenerationRef.current
          ) {
            continue;
          }
          setAutoresponderState(loaded);
          return;
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    refreshInFlightRef.current = run;
    void run.finally(() => {
      if (refreshInFlightRef.current === run) refreshInFlightRef.current = null;
    });
    return run;
  }, [mutationQueue, setError]);
  const flushMutations = useCallback(async (): Promise<void> => {
    for (;;) {
      await mutationQueue.flush();
      const activeRefresh = refreshInFlightRef.current;
      if (activeRefresh) await activeRefresh;
      await mutationQueue.flush();
      if (refreshInFlightRef.current === null) return;
    }
  }, [mutationQueue]);

  return {
    autoresponder,
    setAutoresponder,
    trackMutation,
    getAutoresponder,
    refresh,
    flushMutations,
  };
}

/** A detached rule editor writes directly to the shared store. Reload when a
 * different window announces a save so the docked list cannot stay stale. */
function useExternalRuleRefresh(refresh: () => Promise<void>, setError: SetError) {
  const self = currentRuleWindowLabel();
  useAsyncSubscription(
    onRulesChanged,
    (p) => {
      if (p.source !== self) void refresh();
    },
    (error) => setError(String(error)),
  );
}

function useAutoresponder(
  setError: SetError,
  setRightTab: (tab: RightTab) => void,
  notify: Notify,
  autoresponderActive: boolean,
  mutationQueue: OrderedTaskQueue,
) {
  const {
    autoresponder,
    setAutoresponder,
    trackMutation,
    getAutoresponder,
    refresh,
    flushMutations,
  } = useAutoresponderStore(setError, mutationQueue);
  const { ruleSeed, setRuleSeed, consumeRuleSeed } = useRuleSeedState();
  const [bulkMockProgress, setBulkMockProgress] = useState<BulkMockEvent | null>(null);
  const bulkMockGenerationRef = useRef(0);
  const { ruleHits, resetRuleState } = useRuleHits(
    autoresponder.activeScenarioId,
    autoresponderActive,
    setError,
  );
  useExternalRuleRefresh(refresh, setError);

  const activateScenario = useCallback(
    (scenarioId: string | null) => {
      setAutoresponder((current) => ({ ...current, activeScenarioId: scenarioId }));
      const label = activateLabel(getAutoresponder(), scenarioId);
      void trackMutation(() => api.setActiveScenario(scenarioId, { label })).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [getAutoresponder, refresh, setAutoresponder, setError, trackMutation],
  );

  const setGeneralActive = useCallback(
    (active: boolean) => {
      setAutoresponder((current) => ({ ...current, generalActive: active }));
      void trackMutation(() =>
        api.setGeneralActive(active, {
          label: active ? "Enable General rules" : "Disable General rules",
        }),
      ).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setAutoresponder, setError, trackMutation],
  );

  const createScenario = useCallback(async (): Promise<ScenarioSummary | null> => {
    try {
      const scenario = await trackMutation(() =>
        api.createScenario(null, { label: "New scenario" }),
      );
      setAutoresponder((current) => ({
        ...current,
        scenarios: [...current.scenarios, scenario],
        activeScenarioId: scenario.id,
      }));
      return scenario;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [setAutoresponder, setError, trackMutation]);

  const renameScenario = useCallback(
    async (scenarioId: string, name: string): Promise<void> => {
      setAutoresponder((current) => ({
        ...current,
        scenarios: current.scenarios.map((scenario) =>
          scenario.id === scenarioId ? { ...scenario, name } : scenario,
        ),
      }));
      try {
        await trackMutation(() =>
          api.renameScenario(scenarioId, name, {
            label: "Rename scenario",
            coalesceKey: `scenario:${scenarioId}:name`,
          }),
        );
      } catch (e) {
        setError(String(e));
        await refresh();
        throw e;
      }
    },
    [refresh, setAutoresponder, setError, trackMutation],
  );

  const deleteScenario = useCallback(
    async (scenarioId: string): Promise<void> => {
      const currentAutoresponder = getAutoresponder();
      const label = `Delete scenario "${scenarioNameIn(currentAutoresponder, scenarioId)}"`;
      const deletedRuleIds =
        currentAutoresponder.scenarios
          .find((scenario) => scenario.id === scenarioId)
          ?.rules.map((r) => r.id) ?? [];
      // Reserve the authored-mutation slot before waiting on detached editors.
      // Otherwise a later undo/edit can overtake this click while the flush is
      // awaiting another window and change which action the user actually
      // deletes or undoes first.
      const deletion = trackMutation(async () => {
        await flushDetachedRuleWindows();
        await api.deleteScenario(scenarioId, { label });
      });
      setAutoresponder((current) => ({
        ...current,
        scenarios: current.scenarios.filter((scenario) => scenario.id !== scenarioId),
        activeScenarioId: current.activeScenarioId === scenarioId ? null : current.activeScenarioId,
      }));
      try {
        await deletion;
        for (const ruleId of deletedRuleIds) {
          emitRulesChanged(currentRuleWindowLabel(), ruleId);
        }
      } catch (e) {
        setError(String(e));
        await refresh();
        throw e;
      }
    },
    [getAutoresponder, refresh, setAutoresponder, setError, trackMutation],
  );

  const createRule = useCallback(
    async (scenarioId: string): Promise<RuleSummary | null> => {
      try {
        const rule = await trackMutation(() => api.createRule(scenarioId, { label: "New rule" }));
        setAutoresponder((current) => appendRuleSummary(current, scenarioId, rule));
        return rule;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setAutoresponder, setError, trackMutation],
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
        const summary = await trackMutation(() =>
          api.updateRule(
            scenarioId,
            rule,
            tag ?? {
              label: `Edit rule "${ruleLabel(rule.matcher.url)}"`,
              coalesceKey: `rule:${rule.id}`,
            },
          ),
        );
        setAutoresponder((current) => replaceRuleSummary(current, scenarioId, summary));
        // Tell any detached window showing this rule to reload (source-scoped so
        // this window's own listener ignores it).
        emitRulesChanged(currentRuleWindowLabel(), rule.id);
        return summary;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setAutoresponder, setError, trackMutation],
  );

  const deleteRule = useCallback(
    (scenarioId: string, ruleId: string) => {
      const label = `Delete rule "${ruleLabelIn(getAutoresponder(), ruleId)}"`;
      setAutoresponder((current) => removeRuleSummary(current, scenarioId, ruleId));
      // Tell a detached window for this rule that it's gone (it shows "deleted"
      // instead of leaving a zombie editor whose every save errors).
      emitRulesChanged(currentRuleWindowLabel(), ruleId);
      void trackMutation(() => api.deleteRule(scenarioId, ruleId, { label })).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [getAutoresponder, refresh, setAutoresponder, setError, trackMutation],
  );

  const deleteRules = useCallback(
    (scenarioId: string, ruleIds: string[]) => {
      if (ruleIds.length === 0) return;
      // A single id keeps the descriptive "Delete rule "<url>"" label + path.
      if (ruleIds.length === 1) {
        deleteRule(scenarioId, ruleIds[0]);
        return;
      }
      const label = `Delete ${plural(ruleIds.length, "rule")}`;
      setAutoresponder((current) =>
        ruleIds.reduce((acc, id) => removeRuleSummary(acc, scenarioId, id), current),
      );
      // Any detached window on a deleted rule shows "deleted" instead of a zombie.
      for (const id of ruleIds) emitRulesChanged(currentRuleWindowLabel(), id);
      void trackMutation(() => api.deleteRules(scenarioId, ruleIds, { label })).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [deleteRule, refresh, setAutoresponder, setError, trackMutation],
  );

  const duplicateRule = useCallback(
    async (scenarioId: string, ruleId: string): Promise<RuleSummary | null> => {
      try {
        const copy = await trackMutation(() =>
          api.duplicateRule(scenarioId, ruleId, { label: "Duplicate rule" }),
        );
        setAutoresponder((current) => insertRuleSummaryAfter(current, scenarioId, ruleId, copy));
        return copy;
      } catch (e) {
        setError(String(e));
        return null;
      }
    },
    [setAutoresponder, setError, trackMutation],
  );

  const reorderRule = useCallback(
    (scenarioId: string, ruleId: string, toId: string) => {
      if (ruleId === toId) return;
      setAutoresponder((current) => reorderRuleSummary(current, scenarioId, ruleId, toId));
      void trackMutation(() =>
        api.reorderRule(scenarioId, ruleId, toId, { label: "Reorder rules" }),
      ).catch((e) => {
        setError(String(e));
        void refresh();
      });
    },
    [refresh, setAutoresponder, setError, trackMutation],
  );

  async function mockFlows(ids: string[], scenarioId: string | null): Promise<boolean> {
    const progressGeneration = ++bulkMockGenerationRef.current;
    setError(null);
    setBulkMockProgress({
      type: "progress",
      completed: 0,
      total: ids.length,
      phase: "generating",
    });
    try {
      const label = `Mock ${plural(ids.length, "flow")}`;
      const result = await trackMutation(() =>
        api.mockFlows(ids, scenarioId, { label }, (event) => {
          if (event.type === "progress") {
            if (bulkMockGenerationRef.current === progressGeneration) {
              setBulkMockProgress(event);
            }
            return;
          }
          setAutoresponder((current) =>
            appendBulkRuleSummaries(current, event.scenarioId, event.rules),
          );
        }),
      );
      const firstRuleId = result.newRuleIds[0];
      const n = result.newRuleIds.length;
      if (n === 0) {
        if (bulkMockGenerationRef.current === progressGeneration) {
          setBulkMockProgress(null);
          setRuleSeed(null);
        }
        notify("info", "No selected requests were still available to mock");
        return false;
      }
      if (bulkMockGenerationRef.current === progressGeneration) {
        setRuleSeed({ scenarioId: result.scenarioId, ruleId: firstRuleId });
        setRightTab("autoresponder");
      }
      notify("success", n > 1 ? `Created ${plural(n, "mock rule")}` : "Mock rule created");
      window.setTimeout(() => {
        if (bulkMockGenerationRef.current === progressGeneration) setBulkMockProgress(null);
      }, 500);
      return true;
    } catch (e) {
      if (bulkMockGenerationRef.current === progressGeneration) setBulkMockProgress(null);
      setError(String(e));
      return false;
    }
  }

  async function exportRules(scenarioId: string | null) {
    try {
      await flushDetachedRuleWindows();
      const ok = await api.exportRules(scenarioId);
      if (ok) notify("success", scenarioId ? "Scenario exported" : "All scenarios exported");
    } catch (e) {
      setError(String(e));
    }
  }

  async function importRules(replace: boolean) {
    try {
      const n = await trackMutation(async () => {
        // A replacing import owns its queue position before waiting for other
        // windows, for the same ordering reason as scenario deletion/undo.
        if (replace) await flushDetachedRuleWindows();
        return api.importRules(replace, {
          label: replace ? "Replace rules (import)" : "Import rules",
        });
      });
      if (n > 0) {
        await refresh();
        if (replace) emitRulesChanged(currentRuleWindowLabel(), null);
        notify("success", `Imported ${plural(n, "scenario")}`);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return {
    autoresponder,
    refresh,
    flushMutations,
    trackMutation,
    ruleSeed,
    consumeRuleSeed,
    bulkMockProgress,
    activateScenario,
    setGeneralActive,
    createScenario,
    renameScenario,
    deleteScenario,
    createRule,
    loadRule,
    updateRule,
    deleteRule,
    deleteRules,
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
function useHistory(
  refreshAutoresponder: () => Promise<void>,
  setError: SetError,
  trackMutation: <T>(operation: () => Promise<T>) => Promise<T>,
) {
  const [version, setVersion] = useState(0);
  const pendingRef = useRef<Set<Promise<void>>>(new Set());

  const run = useCallback(
    (action: () => Promise<void>): Promise<void> => {
      // Reserve the shared mutation-queue slot synchronously. Putting the
      // detached-editor flush before `trackMutation` lets a later rule/delete
      // click overtake the undo while that flush is awaiting acknowledgements.
      const task = trackMutation(async () => {
        await flushDetachedRuleWindows();
        await action();
      })
        .then(async () => {
          setVersion((v) => v + 1);
          await refreshAutoresponder();
          // Nudge any open detached rule windows to re-fetch their (reverted) rule.
          // Undo/redo can touch any rule, so signal a reload-all (ruleId = null).
          emitRulesChanged(currentRuleWindowLabel(), null);
        })
        .catch((e) => {
          setError(String(e));
        });
      pendingRef.current.add(task);
      void task.finally(() => pendingRef.current.delete(task));
      return task;
    },
    [refreshAutoresponder, setError, trackMutation],
  );

  const undo = useCallback(() => run(api.historyUndo), [run]);
  const redo = useCallback(() => run(api.historyRedo), [run]);
  const flush = useCallback(async (): Promise<void> => {
    for (;;) {
      const pending = [...pendingRef.current];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }, []);

  return { version, undo, redo, flush };
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

function useSession(
  setError: SetError,
  onOpened: () => void,
  notify: Notify,
  refreshRules: () => Promise<void>,
  trackRuleMutation: <T>(operation: () => Promise<T>) => Promise<T>,
  flushRuleSnapshot: () => Promise<void>,
  viewer: boolean,
) {
  const [harRulesOffer, setHarRulesOffer] = useState<ScenarioPreview[] | null>(null);

  function opened(result: OpenedCapture) {
    onOpened();
    notify("success", `Opened ${plural(result.count, "flow")}`);
    // A viewer can't edit or persist rules, so it never offers the import.
    setHarRulesOffer(!viewer && result.embeddedRules?.length ? result.embeddedRules : null);
  }
  async function saveSession(includeRules: boolean) {
    try {
      if (includeRules) await flushRuleSnapshot();
      const ok = await api.saveSession(includeRules);
      if (ok) notify("success", "Session saved");
    } catch (e) {
      setError(String(e));
    }
  }
  async function openCapture() {
    try {
      const result = await api.openCapture();
      if (result === null) return;
      opened(result);
    } catch (e) {
      setError(String(e));
    }
  }
  /** Open a capture dragged from the file manager (issue #100) — same effect as
   *  `openCapture`, but the bytes come from the dropped File rather than the
   *  native picker. */
  async function openDropped(file: File, ext: CaptureExt) {
    try {
      opened(await api.openDroppedCapture(await readFileAsBase64(file), ext));
    } catch (e) {
      setError(String(e));
    }
  }
  /** Accept the offer: import the bundle parked by the open (issue #113). */
  async function applyHarRules() {
    try {
      const n = await trackRuleMutation(() => api.applyHarRules({ label: "Import rules (HAR)" }));
      setHarRulesOffer(null);
      await refreshRules();
      notify("success", `Imported ${plural(n, "scenario")}`);
    } catch (e) {
      setError(String(e));
    }
  }
  function dismissHarRules() {
    setHarRulesOffer(null);
  }
  return { saveSession, openCapture, openDropped, harRulesOffer, applyHarRules, dismissHarRules };
}

async function copyFlowAsCurlAction(id: string, notify: Notify, setError: SetError) {
  try {
    const d = await api.getFlow(id, false, true);
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
  visibleFlows: FlowSummary[],
  selectedId: string | null,
  pendingSelectRef: MutableRefObject<PendingSelect>,
  notify: Notify,
  setError: SetError,
  mutationQueue: OrderedTaskQueue,
): void {
  const plan = capturedDeletePlan(
    flows,
    visibleFlows.map((f) => f.id),
    selectedId,
  );
  if (!plan) {
    notify("info", "No captured requests to delete");
    return;
  }
  const pending = { nextId: plan.nextId, deleted: plan.deleted };
  pendingSelectRef.current = pending;
  void mutationQueue
    .run(api.removeCapturedFlows)
    .then(() => notify("success", `Deleted ${plural(plan.capturedCount, "captured request")}`))
    .catch((e) => {
      // A later queued delete may already own the deferred selection plan.
      // Failure of this operation must not erase that newer hand-off.
      if (pendingSelectRef.current === pending) pendingSelectRef.current = null;
      setError(String(e));
    });
}

/** Bundles the imported/captured split and the "Delete captured" action (issue
 *  #49) so the composition root just wires it, like the other feature hooks. */
function useCapturedDelete(
  flows: FlowSummary[],
  visibleFlows: FlowSummary[],
  selectedId: string | null,
  pendingSelectRef: MutableRefObject<PendingSelect>,
  notify: Notify,
  setError: SetError,
  mutationQueue: OrderedTaskQueue,
) {
  const counts = useMemo(() => countFlows(flows), [flows]);
  const deleteCaptured = () =>
    deleteCapturedAction(
      flows,
      visibleFlows,
      selectedId,
      pendingSelectRef,
      notify,
      setError,
      mutationQueue,
    );
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
  const [ownershipKnown, setOwnershipKnown] = useState(false);
  const ownershipGenerationRef = useRef(0);
  const openingRuleWindowsRef = useRef(new Map<string, symbol>());
  const arRef = useRef(ar);
  arRef.current = ar;

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    setOwnershipKnown(false);
    // Install the destroyed listener before taking the recovery snapshot. This
    // brackets windows that outlived a main-webview reload without a gap where
    // an editor can close between listOpenRuleIds and listener registration.
    void (async () => {
      try {
        for (const register of [
          () =>
            onRuleWindowClosed((p) => {
              // A shell close beats any creation/focus promise that resolves
              // late for the same label; that completion must not re-lock a
              // window which no longer exists.
              openingRuleWindowsRef.current.delete(p.ruleId);
              ownershipGenerationRef.current += 1;
              setOpenRuleWindows((prev) => {
                if (!prev.has(p.ruleId)) return prev;
                const next = new Set(prev);
                next.delete(p.ruleId);
                return next;
              });
              void refresh();
            }),
          () => onRuleWindowResized((size) => saveRuleWindowSize(size)),
        ]) {
          const unlisten = await register();
          if (!active) {
            unlisten();
            return;
          }
          unlisteners.push(unlisten);
        }
        for (;;) {
          const generation = ownershipGenerationRef.current;
          const ids = await listOpenRuleIds();
          if (!active) return;
          // A local open or shell close overlapped the snapshot. Retry so an
          // older window list cannot unlock an editor whose OS window just won
          // the creation/focus race.
          if (generation !== ownershipGenerationRef.current) continue;
          const recovered = new Set(ids);
          for (const id of openingRuleWindowsRef.current.keys()) recovered.add(id);
          setOpenRuleWindows(recovered);
          setOwnershipKnown(true);
          break;
        }
      } catch (error) {
        for (const unlisten of unlisteners.splice(0)) unlisten();
        if (active) setError(`Could not establish detached rule ownership: ${error}`);
      }
    })();
    return () => {
      active = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [refresh, setError]);

  const openRuleWindow = useCallback(
    (scenarioId: string, ruleId: string) => {
      const rule = arRef.current.scenarios
        .find((s) => s.id === scenarioId)
        ?.rules.find((r) => r.id === ruleId);
      const title = rule ? ruleLabel(rule.matcher.url) : "Rule";
      const openToken = Symbol(ruleId);
      openingRuleWindowsRef.current.set(ruleId, openToken);
      ownershipGenerationRef.current += 1;
      setOpenRuleWindows((prev) => (prev.has(ruleId) ? prev : new Set(prev).add(ruleId)));
      void openOrFocusRuleWindow(ruleId, scenarioId, title)
        .then(() => {
          if (openingRuleWindowsRef.current.get(ruleId) !== openToken) return;
          openingRuleWindowsRef.current.delete(ruleId);
          ownershipGenerationRef.current += 1;
          setOpenRuleWindows((prev) => (prev.has(ruleId) ? prev : new Set(prev).add(ruleId)));
        })
        .catch((e) => {
          if (openingRuleWindowsRef.current.get(ruleId) !== openToken) return;
          openingRuleWindowsRef.current.delete(ruleId);
          ownershipGenerationRef.current += 1;
          setError(String(e));
          // A focus operation can fail while the detached writer still exists.
          // Re-list before unlocking; if even the lookup fails, fall back to the
          // conservative unknown-ownership state rather than exposing two writers.
          void (async () => {
            try {
              for (;;) {
                const generation = ownershipGenerationRef.current;
                const ids = await listOpenRuleIds();
                if (generation !== ownershipGenerationRef.current) continue;
                const recovered = new Set(ids);
                for (const id of openingRuleWindowsRef.current.keys()) recovered.add(id);
                setOpenRuleWindows(recovered);
                setOwnershipKnown(true);
                return;
              }
            } catch {
              setOwnershipKnown(false);
            }
          })();
        });
    },
    [setError],
  );

  const guardedOpenRuleWindows = useMemo(() => {
    if (ownershipKnown) return openRuleWindows;
    return new Set(ar.scenarios.flatMap((scenario) => scenario.rules.map((rule) => rule.id)));
  }, [ar.scenarios, openRuleWindows, ownershipKnown]);

  return { openRuleWindows: guardedOpenRuleWindows, openRuleWindow };
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
  const openQueueRef = useRef<OrderedTaskQueue | null>(null);
  openQueueRef.current ??= new OrderedTaskQueue();
  const openQueue = openQueueRef.current;

  function openCompare() {
    const selected = selectedRef.current;
    if (selected.length === 0) {
      notify("info", "Select one or more requests to compare first");
      return;
    }
    const ids = selected.map((f) => f.id);
    const seed =
      selected.length === 2 ? { left: [ids[0]], right: [ids[1]] } : { left: ids, right: [] };
    // Tauri invokes can complete out of submission order. Keep the mailbox
    // write and window notification together so two rapid Compare actions
    // cannot leave the older selection as the final seed.
    void openQueue
      .run(async () => {
        await api.setCompareSeed(seed);
        await openOrFocusCompareWindow();
      })
      .catch((e) => notify("error", String(e)));
  }

  return { openCompare };
}

function useTrafficWorkspace(
  flowStore: ReturnType<typeof useFlowStore>,
  headerColumns: string[],
  view: Pick<
    ReturnType<typeof useViewState>,
    "rightCollapsed" | "setRightCollapsed" | "setRightTab" | "decode" | "fullBody"
  >,
  notify: Notify,
  setError: SetError,
) {
  const columns = usePersistentColumns(headerColumns);
  const { sort, toggleSort, sortedFlows } = useFlowSort(flowStore.flows, columns.visibleColumns);
  const filtering = useTrafficFilter(sortedFlows, setError);
  const savedFilters = useSavedFilters(sortedFlows, filtering.matchedIds, setError);
  const filterActions = useFilterActions(
    filtering,
    savedFilters,
    {
      rightCollapsed: view.rightCollapsed,
      setRightCollapsed: view.setRightCollapsed,
      setRightTab: view.setRightTab,
    },
    notify,
  );
  const selection = useSelection(savedFilters.visibleFlows);
  const selectedSummary = selection.selectedId
    ? flowStore.flowsRef.current.get(selection.selectedId)
    : undefined;
  const selectedSummaries = useMemo(
    () => sortedFlows.filter((flow) => selection.selectedIds.has(flow.id)),
    [sortedFlows, selection.selectedIds],
  );
  const inspector = useFlowDetail(
    selection.selectedId,
    view.decode,
    view.fullBody,
    selectedSummary,
  );
  const availability = useAvailabilityCheck(
    sortedFlows,
    selection.selectedIds,
    savedFilters.combinedMatchedIds,
    notify,
    setError,
  );
  const compare = useCompare(selectedSummaries, notify);

  return {
    columns,
    sort,
    toggleSort,
    sortedFlows,
    filtering,
    savedFilters,
    filterActions,
    selection,
    selectedSummary,
    selectedSummaries,
    inspector,
    availability,
    compare,
  };
}

function useSettingsCoordinator(settings: ProxySettings) {
  const settingsSaveQueueRef = useRef<OrderedTaskQueue | null>(null);
  settingsSaveQueueRef.current ??= new OrderedTaskQueue();
  const settingsSaveErrorRef = useRef<unknown>(null);
  const settingsMutationGenerationRef = useRef(0);
  // Async listener operations must merge into the newest settings snapshot,
  // not the render that originally launched them.
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  // The UI is optimistic, so `settings` can contain a snapshot whose queued
  // full-settings write has not succeeded. Rollbacks and change comparisons
  // use the last durable snapshot instead of resurrecting an earlier failed edit.
  const durableSettingsRef = useRef(settings);
  return {
    settingsSaveQueue: settingsSaveQueueRef.current,
    settingsSaveErrorRef,
    settingsMutationGenerationRef,
    latestSettingsRef,
    durableSettingsRef,
  };
}

export function useAppState(flushInlineRules: () => Promise<void> = () => Promise.resolve()) {
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
  const caMutationGenerationRef = useRef(0);
  const [proxyStartupReady, setProxyStartupReady] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const { viewer, setViewer, launchViewer } = useViewerMode(notify, setError);

  const settings = useSettings();
  const {
    settingsSaveQueue,
    settingsSaveErrorRef,
    settingsMutationGenerationRef,
    latestSettingsRef,
    durableSettingsRef,
  } = useSettingsCoordinator(settings.settings);
  // Every authored rule/traffic mutation shares one submission order. The
  // backend also serializes history transactions, but async Tauri commands can
  // otherwise acquire that lock in a different order than the user's clicks.
  const authoredMutationQueueRef = useRef<OrderedTaskQueue | null>(null);
  authoredMutationQueueRef.current ??= new OrderedTaskQueue();
  const authoredMutationQueue = authoredMutationQueueRef.current;
  const flowStore = useFlowStore(setError, authoredMutationQueue);
  const {
    columns,
    sort,
    toggleSort,
    sortedFlows,
    filtering,
    savedFilters,
    filterActions,
    selection,
    selectedSummary,
    selectedSummaries,
    inspector,
    availability,
    compare,
  } = useTrafficWorkspace(
    flowStore,
    settings.settings.headerColumns,
    { rightCollapsed, setRightCollapsed, setRightTab, decode, fullBody },
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
    savedFilters.visibleFlows,
    selection.selectedId,
    pendingSelectRef,
    notify,
    setError,
    authoredMutationQueue,
  );

  const proxy = useProxyControl(
    settings.settings,
    setError,
    (port) => saveSettings({ ...latestSettingsRef.current, port }),
    notify,
    proxyStartupReady && settingsReady,
  );
  useSystemHotkeys(
    settings.settings.systemProxyHotkey,
    proxy.toggleSystemProxyHotkey,
    setError,
    proxyStartupReady && settingsReady && !viewer,
  );
  useProxyIndicator(proxy.systemProxy);
  const autoresponderActive = !viewer && rightTab === "autoresponder";
  const ar = useAutoresponder(
    setError,
    setRightTab,
    notify,
    autoresponderActive,
    authoredMutationQueue,
  );
  const ruleWindows = useRuleWindows(ar.autoresponder, ar.refresh, setError);
  const history = useHistory(ar.refresh, setError, ar.trackMutation);
  const shortcuts = usePersistentShortcuts();
  async function flushRuleSnapshot(): Promise<void> {
    await flushDetachedRuleWindows();
    await flushInlineRules();
    await ar.flushMutations();
  }
  const session = useSession(
    setError,
    () => {
      selection.clearSelection();
      inspector.setDetail(null);
    },
    notify,
    ar.refresh,
    ar.trackMutation,
    flushRuleSnapshot,
    viewer,
  );
  const trafficSplit = useSplitRatio({
    initial: 0.55,
    min: 0.18,
    max: 0.82,
    storageKey: "germi.trafficSplit",
  });
  const startupStartedRef = useRef(false);

  useEffect(() => {
    // React Strict Mode replays mount effects in development. Startup owns real
    // proxy/system state, so run it once rather than racing two status snapshots
    // and two auto-start attempts against the same listener.
    if (!startupStartedRef.current) {
      startupStartedRef.current = true;
      void loadInitialState({
        setRunning: proxy.setRunning,
        setBoundPort: proxy.setBoundPort,
        setBoundAllowRemote: proxy.setBoundAllowRemote,
        setSystemProxy: proxy.setSystemProxy,
        setViewer,
        loadAutoresponder: ar.refresh,
        setSettings: (loaded) => {
          latestSettingsRef.current = loaded;
          settings.setSettings(loaded);
        },
        setDurableSettings: (loaded) => {
          durableSettingsRef.current = loaded;
        },
        setSettingsReady: () => setSettingsReady(true),
        getSettingsMutationGeneration: () => settingsMutationGenerationRef.current,
        getLatestSettings: () => latestSettingsRef.current,
        getCaMutationGeneration: () => caMutationGenerationRef.current,
        getProxyOperationGeneration: proxy.getOperationGeneration,
        serializeProxyOperation: proxy.serializeOperation,
        flushSettingsSaves: () => settingsSaveQueue.flush(),
        reconcileListenerSettings: (previous) =>
          proxy.applyListenChange(previous, latestSettingsRef.current),
        onPortBound: (port) => saveSettings({ ...latestSettingsRef.current, port }),
        setCaInfo,
        loadInitialFlows: flowStore.loadInitial,
        setError,
      }).then(setProxyStartupReady);
    }
    const focusTimer = window.setTimeout(() => filterInputRef.current?.focus(), 60);
    return () => clearTimeout(focusTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveSettings(next: ProxySettings) {
    settingsMutationGenerationRef.current += 1;
    latestSettingsRef.current = next;
    settings.setSettings(next);
    void settingsSaveQueue
      .run(async () => {
        const durableBefore = durableSettingsRef.current;
        try {
          await persistSettings(next, durableBefore.headerColumns, flowStore.refresh, setError);
          durableSettingsRef.current = next;
          settingsSaveErrorRef.current = null;
        } catch (writeError) {
          let durable = durableBefore;
          let readError: unknown;
          try {
            // A command can report failure after the durable side effect, and a
            // settings import can also have written while this save was queued.
            // Re-read before rolling the optimistic UI back.
            durable = await api.getSettings();
            durableSettingsRef.current = durable;
          } catch (error) {
            readError = error;
          }
          // Keep later optimistic edits intact; only roll back when this failed
          // snapshot is still the one shown by the UI. The fallback is the last
          // known durable value, never another optimistic snapshot.
          if (isEqual(latestSettingsRef.current, next)) {
            latestSettingsRef.current = durable;
            settings.setSettings(durable);
          }
          const message =
            readError === undefined
              ? String(writeError)
              : `${writeError}; the durable settings could not be reloaded (${readError})`;
          // A command can reject after its durable side effect. The re-read is
          // authoritative: only retain a shutdown-blocking error when the
          // requested snapshot really is absent.
          const reachedRequestedState = readError === undefined && isEqual(durable, next);
          settingsSaveErrorRef.current = reachedRequestedState ? null : new Error(message);
          setError(message);
          // A rejected IPC command can still have committed the settings. In
          // that case the listener must follow the authoritative snapshot just
          // as it does after an ordinary successful write; returning here would
          // leave disk/UI on the new address while the proxy stayed on the old
          // one. Only stop when the re-read proves the requested state is absent
          // (or the re-read itself failed).
          if (!reachedRequestedState) return;
        }
        await proxy.applyListenChange(durableBefore, next);
      })
      .catch((error) => {
        settingsSaveErrorRef.current = error;
        setError(String(error));
      });
  }

  function applyImportedSettings(next: ProxySettings) {
    settingsMutationGenerationRef.current += 1;
    latestSettingsRef.current = next;
    settings.setSettings(next);
    // The import command already persisted once. Queue the imported snapshot
    // behind any ordinary save that was waiting in this webview, so an older
    // full-settings write cannot land afterward and silently undo the import.
    void settingsSaveQueue
      .run(async () => {
        const durableBefore = durableSettingsRef.current;
        let persisted = next;
        try {
          await api.setSettings(next);
          durableSettingsRef.current = next;
          settingsSaveErrorRef.current = null;
        } catch (writeError) {
          // The import command persisted before returning, but an older queued
          // webview save may have landed afterward. If the ordering write fails,
          // re-read the backend instead of leaving the UI/listener claiming the
          // imported snapshot won. Preserve any still-newer optimistic UI edit;
          // its own queued write remains responsible for it.
          try {
            persisted = await api.getSettings();
            durableSettingsRef.current = persisted;
          } catch (readError) {
            persisted = durableBefore;
            if (isEqual(latestSettingsRef.current, next)) {
              latestSettingsRef.current = persisted;
              settings.setSettings(persisted);
            }
            throw Object.assign(
              new Error(
                `Imported settings could not be ordered (${writeError}), and the durable ` +
                  `settings could not be reloaded (${readError}); restored the last known snapshot`,
              ),
              { cause: writeError, readError },
            );
          }
          if (isEqual(latestSettingsRef.current, next)) {
            latestSettingsRef.current = persisted;
            settings.setSettings(persisted);
          }
          settingsSaveErrorRef.current = isEqual(persisted, next)
            ? null
            : new Error(String(writeError));
          setError(
            `Imported settings could not be re-saved; reloaded the durable state: ${writeError}`,
          );
        }
        emitSettingsChanged();
        if (!isEqual(persisted.headerColumns, durableBefore.headerColumns)) {
          try {
            await flowStore.refresh();
          } catch (error) {
            // A traffic refresh is independent of the already-durable import;
            // still apply its listener change below.
            setError(String(error));
          }
        }
        // Rebind after the ordered persistence step. Otherwise a queued older
        // save can temporarily move the listener back after the import UI has
        // already shown the new address.
        await proxy.applyListenChange(durableBefore, persisted);
      })
      .catch((error) => {
        settingsSaveErrorRef.current = error;
        setError(String(error));
      });
  }

  const flushSettings = useCallback(async (): Promise<void> => {
    await settingsSaveQueue.flush();
    if (settingsSaveErrorRef.current !== null) throw settingsSaveErrorRef.current;
  }, [settingsSaveErrorRef, settingsSaveQueue]);

  function handleRowClick(id: string, e: ReactMouseEvent) {
    setFullBody(false);
    selection.onRowClick(id, e);
    setRightTab("inspector");
  }

  function handleKeySelect(id: string, extend: boolean) {
    setFullBody(false);
    selection.selectByKeyboard(id, extend);
    if (!extend) setRightTab("inspector");
  }

  function selectAllVisible() {
    const matched = savedFilters.combinedMatchedIds;
    const visible = savedFilters.visibleFlows;
    const ids = matched
      ? visible.filter((f) => matched.has(f.id)).map((f) => f.id)
      : visible.map((f) => f.id);
    selection.selectAll(ids);
    if (ids.length > 1) setRightTab("inspector");
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
    void copyText(notify, "URL", flowUrl(fs));
  }

  // F2: reveal the Autoresponder (un-collapse / switch to its tab), then focus
  // the mock response-body editor if a respond rule is open.
  function focusMockBody() {
    if (rightCollapsed) setRightCollapsed(false);
    setRightTab("autoresponder");
    focusMockResponseBody();
  }

  function clearTraffic() {
    void authoredMutationQueue.run(api.clearFlows).catch((e) => setError(String(e)));
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

  // Rule count the save-options dialog offers to embed; null = dialog closed.
  // With nothing currently mocking there is nothing to offer, so Save goes
  // straight to the file picker (issue #113).
  const [saveOptions, setSaveOptions] = useState<number | null>(null);

  function requestSaveSession() {
    void (async () => {
      try {
        // The detail editor owns a debounced full-rule snapshot, while detached
        // windows and queued mutations can be ahead of the summary in this
        // render. Flush first, then count the authoritative backend state so a
        // newly-enabled rule is neither omitted from the offer nor the HAR.
        await flushRuleSnapshot();
        const count = mockingRuleCount(await api.getAutoresponderSummary());
        if (count === 0) {
          await session.saveSession(false);
          return;
        }
        setSaveOptions(count);
      } catch (error) {
        setError(String(error));
      }
    })();
  }

  function confirmSaveSession(includeRules: boolean) {
    setSaveOptions(null);
    void session.saveSession(includeRules);
  }

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
    const pending = { nextId, deleted: new Set(ids) };
    pendingSelectRef.current = pending;
    void authoredMutationQueue
      .run(() => api.removeFlows(ids))
      .catch((e) => {
        if (pendingSelectRef.current === pending) pendingSelectRef.current = null;
        setError(String(e));
      });
  }

  function refreshCa() {
    const generation = ++caMutationGenerationRef.current;
    void api
      .caInfo()
      .then((info) => {
        if (generation === caMutationGenerationRef.current) setCaInfo(info);
      })
      .catch((error) => setError(String(error)));
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
    saveOptions,
    requestSaveSession,
    confirmSaveSession,
    cancelSaveSession: () => setSaveOptions(null),
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
    flushSettings,
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
    settingsReady,
  };
}
