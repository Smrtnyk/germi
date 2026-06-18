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
import { useResizable } from "./useResizable";
import { parseFilter, statusClass } from "./filter";
import { resolveColumns, DEFAULT_COLUMNS } from "./columns";
import type {
  AutoResponder,
  CaInfo,
  FlowDetail,
  FlowSummary,
  ProxySettings,
  ResourceKind,
} from "./types";
import { Toolbar } from "./components/Toolbar";
import { FilterChips } from "./components/FilterChips";
import { TrafficList } from "./components/TrafficList";
import { FlowInspector } from "./components/FlowInspector";
import { AutoresponderPanel } from "./components/AutoresponderPanel";
import { CaDialog } from "./components/CaDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";

type RightTab = "inspector" | "autoresponder";

export function App() {
  const [running, setRunning] = useState(false);
  const [systemProxy, setSystemProxy] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("inspector");
  const [decode, setDecode] = useState(true);
  const [fullBody, setFullBody] = useState(false);
  const [filter, setFilter] = useState("");
  const [typeChips, setTypeChips] = useState<Set<ResourceKind>>(new Set());
  const [statusChips, setStatusChips] = useState<Set<string>>(new Set());
  const [bodyMatchIds, setBodyMatchIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [autoresponder, setAutoresponder] = useState<AutoResponder>({
    scenarios: [],
    activeScenarioId: null,
  });
  const [selectRuleId, setSelectRuleId] = useState<string | null>(null);
  const [pickScenarioId, setPickScenarioId] = useState("");
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);
  const [caOpen, setCaOpen] = useState(false);
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
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("germi.columns") ?? "null");
      return Array.isArray(saved) && saved.length ? saved : DEFAULT_COLUMNS;
    } catch {
      return DEFAULT_COLUMNS;
    }
  });
  const [error, setError] = useState<string | null>(null);

  const flowsRef = useRef<Map<string, FlowSummary>>(new Map());
  const orderRef = useRef<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const summaryMatchedRef = useRef<Set<string>>(new Set());
  // Mirrors settings.maxFlows for the mount-time subscription (empty-deps) effect,
  // which would otherwise close over the initial default forever.
  const maxFlowsRef = useRef(settings.maxFlows);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    maxFlowsRef.current = settings.maxFlows;
  }, [settings.maxFlows]);

  // Floored to the width the traffic columns actually need (reported by the
  // list), so the divider can't squeeze the list into the right panel.
  const [trafficMin, setTrafficMin] = useState(640);
  const trafficResize = useResizable({
    initial: 760,
    min: trafficMin,
    getMax: () => window.innerWidth - 440,
    storageKey: "germi.trafficWidth",
  });

  useEffect(() => {
    // Rebuild the local flow map from the backend's authoritative list — used to
    // resynchronize after a lagged event stream (dropped events) and to drop ids
    // the bounded backend store has already evicted.
    const reconcile = async () => {
      try {
        const fresh = await api.listFlows();
        const map = flowsRef.current;
        const order = orderRef.current;
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
    };

    const channel = subscribeFlows((events) => {
      const map = flowsRef.current;
      const order = orderRef.current;
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
      // Mirror the backend's bounded store: evict oldest beyond the cap so the
      // frontend can't grow unbounded (and stays in sync after backend eviction).
      const cap = Math.max(1, maxFlowsRef.current);
      if (order.length > cap) {
        const removed = order.splice(0, order.length - cap);
        for (const id of removed) map.delete(id);
      }
      bump();
      if (resync) void reconcile();
    });
    return () => {
      channel.onmessage = () => {};
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const isRunning = await api.proxyStatus();
        setRunning(isRunning);
        setAutoresponder(await api.getAutoresponder());
        const loaded = await api.getSettings();
        setSettings(loaded);
        setCaInfo(await api.caInfo());
        const initial = await api.listFlows();
        const map = flowsRef.current;
        const order = orderRef.current;
        for (const s of initial) {
          if (!map.has(s.id)) order.push(s.id);
          map.set(s.id, s);
        }
        bump();
        // Auto-start capture if configured.
        if (loaded.captureOnStart && !isRunning) {
          await api.startProxy(loaded.port, loaded.allowRemote);
          setRunning(true);
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const selectedSummary = selectedId ? flowsRef.current.get(selectedId) : undefined;

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
  }, [
    selectedId,
    decode,
    fullBody,
    selectedSummary?.status,
    selectedSummary?.durationMs,
  ]);

  // Defer the heavy synchronous match path (parse + per-flow matching, incl. a
  // user /regex/) off the keystroke so typing stays responsive even with many
  // flows or a slow pattern. The input stays bound to the immediate `filter`.
  const deferredFilter = useDeferredValue(filter);
  const parsed = useMemo(() => parseFilter(deferredFilter), [deferredFilter]);

  // The list shows ALL flows (Fiddler-style highlight, not filter-hide).
  const allFlows = useMemo(() => {
    const arr: FlowSummary[] = [];
    for (const id of orderRef.current) {
      const s = flowsRef.current.get(id);
      if (s) arr.push(s);
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const hasFilter =
    filter.trim() !== "" || typeChips.size > 0 || statusChips.size > 0;

  // Ids matching the chips + summary tokens (instant, frontend).
  const summaryMatched = useMemo(() => {
    const set = new Set<string>();
    for (const s of allFlows) {
      if (typeChips.size && !typeChips.has(s.kind)) continue;
      if (statusChips.size && !statusChips.has(statusClass(s.status))) continue;
      if (!parsed.matchSummary(s)) continue;
      set.add(s.id);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFlows, deferredFilter, typeChips, statusChips]);
  summaryMatchedRef.current = summaryMatched;

  // Body search is the only filter that hits the backend (debounced/cancellable).
  useEffect(() => {
    if (parsed.bodyTerms.length === 0) {
      setBodyMatchIds(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        let ids = [...summaryMatchedRef.current];
        for (const bt of parsed.bodyTerms) {
          const result = await api.searchBodies(bt.value, bt.side, bt.regex, ids);
          if (cancelled) return;
          const hit = new Set(result);
          ids = ids.filter((id) => (bt.neg ? !hit.has(id) : hit.has(id)));
        }
        if (!cancelled) setBodyMatchIds(new Set(ids));
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // `tick` re-runs the search as new flows arrive (debounced/cancelled below),
    // so flows captured after the filter was set still get highlighted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFilter, typeChips, statusChips, tick]);

  // The highlighted set: null when no filter is active (nothing dimmed).
  const matchedIds = useMemo<Set<string> | null>(() => {
    if (!hasFilter) return null;
    if (parsed.bodyTerms.length === 0 || bodyMatchIds === null) return summaryMatched;
    return new Set([...summaryMatched].filter((id) => bodyMatchIds.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFilter, summaryMatched, bodyMatchIds, deferredFilter]);

  function toggleTypeChip(k: ResourceKind) {
    setTypeChips((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }
  function toggleStatusChip(c: string) {
    setStatusChips((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }

  useEffect(() => {
    localStorage.setItem("germi.columns", JSON.stringify(columnOrder));
  }, [columnOrder]);

  const visibleColumns = useMemo(
    () => resolveColumns(columnOrder, settings.headerColumns),
    [columnOrder, settings.headerColumns],
  );

  function editComment(id: string, comment: string | null) {
    const s = flowsRef.current.get(id);
    if (s) {
      flowsRef.current.set(id, { ...s, comment });
      bump();
    }
    void api.setFlowComment(id, comment).catch((e) => setError(String(e)));
  }

  // Persist + apply settings; when the pinned header columns change, re-list so
  // already-captured rows pick up (or drop) those header values.
  function saveSettings(next: ProxySettings) {
    const headersChanged =
      JSON.stringify(next.headerColumns) !== JSON.stringify(settings.headerColumns);
    setSettings(next);
    void api
      .setSettings(next)
      .then(async () => {
        if (headersChanged) {
          const fresh = await api.listFlows();
          for (const fs of fresh) flowsRef.current.set(fs.id, fs);
          bump();
        }
      })
      .catch((e) => setError(String(e)));
  }

  function onRowClick(id: string, e: ReactMouseEvent) {
    setFullBody(false); // reset "load full" when changing selection
    if (e.shiftKey && anchorRef.current) {
      const ids = allFlows.map((f) => f.id);
      const a = ids.indexOf(anchorRef.current);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds(new Set(ids.slice(lo, hi + 1)));
      }
      setSelectedId(id);
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
      setSelectedId(id);
      anchorRef.current = id;
    } else {
      setSelectedIds(new Set([id]));
      setSelectedId(id);
      anchorRef.current = id;
    }
    setRightTab("inspector");
  }

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

  function clearTraffic() {
    void api.clearFlows();
    setSelectedId(null);
    setSelectedIds(new Set());
    setDetail(null);
  }

  async function importArchive() {
    setError(null);
    try {
      await api.importArchive(); // imported flows arrive via the event stream
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
      // Backend clears + reloads; the new flows arrive via the event stream.
      await api.openSession();
      setSelectedId(null);
      setSelectedIds(new Set());
      setDetail(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function saveAutoresponder(next: AutoResponder) {
    setAutoresponder(next);
    // Debounce the backend persist so editing a large mock body doesn't write
    // the whole config on every keystroke.
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.setAutoresponder(next).catch((e) => setError(String(e)));
    }, 300);
  }

  /** Seed a single Respond rule from a flow (backend has its full body). */
  async function mockFromFlow(d: FlowDetail) {
    setError(null);
    try {
      const result = await api.mockFlows([d.id], autoresponder.activeScenarioId);
      setAutoresponder(result.autoresponder);
      setSelectRuleId(result.newRuleIds[0] ?? null);
      setRightTab("autoresponder");
    } catch (e) {
      setError(String(e));
    }
  }

  const pick =
    pickScenarioId ||
    autoresponder.activeScenarioId ||
    autoresponder.scenarios[0]?.id ||
    "__new__";

  async function addSelectedToScenario() {
    const ids = allFlows.filter((f) => selectedIds.has(f.id)).map((f) => f.id);
    if (ids.length === 0) return;
    setError(null);
    try {
      const result = await api.mockFlows(ids, pick === "__new__" ? null : pick);
      setAutoresponder(result.autoresponder);
      setSelectRuleId(result.newRuleIds[0] ?? null);
      setRightTab("autoresponder");
      setSelectedIds(new Set());
      setPickScenarioId("");
    } catch (e) {
      setError(String(e));
    }
  }

  const activeScenario =
    autoresponder.scenarios.find((s) => s.id === autoresponder.activeScenarioId)
      ?.name ?? null;

  return (
    <div className="app">
      <Toolbar
        running={running}
        port={settings.port}
        onPortChange={(p) => saveSettings({ ...settings, port: p })}
        onToggleProxy={toggleProxy}
        systemProxy={systemProxy}
        onToggleSystemProxy={toggleSystemProxy}
        onInstallCa={() => setCaOpen(true)}
        onImport={importArchive}
        decode={decode}
        onToggleDecode={() => setDecode((d) => !d)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSession={openSession}
        onSaveSession={saveSession}
        onClear={clearTraffic}
        filter={filter}
        onFilterChange={setFilter}
      />

      {error && (
        <div className="error-bar" onClick={() => setError(null)}>
          {error} <span className="dismiss">(dismiss)</span>
        </div>
      )}

      <main
        className="body workbench"
        style={{
          gridTemplateColumns: `minmax(0, ${trafficResize.size}px) 6px minmax(440px, 1fr)`,
        }}
      >
        <div className="traffic-col">
          <FilterChips
            typeChips={typeChips}
            statusChips={statusChips}
            onToggleType={toggleTypeChip}
            onToggleStatus={toggleStatusChip}
            searching={searching}
            matchCount={matchedIds ? matchedIds.size : null}
            total={allFlows.length}
          />
          {selectedIds.size >= 2 && (
            <div className="selection-bar">
              <span>
                <strong>{selectedIds.size}</strong> selected
              </span>
              <select
                value={pick}
                onChange={(e) => setPickScenarioId(e.target.value)}
              >
                {autoresponder.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="__new__">+ New scenario</option>
              </select>
              <button className="btn primary" onClick={addSelectedToScenario}>
                Add to scenario
              </button>
              <button className="btn" onClick={() => setSelectedIds(new Set())}>
                Clear
              </button>
            </div>
          )}
          <TrafficList
            flows={allFlows}
            columns={visibleColumns}
            matchedIds={matchedIds}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onRowClick={onRowClick}
            onContentWidth={setTrafficMin}
            onCommentEdit={editComment}
          />
        </div>

        <div
          className="resizer"
          onPointerDown={trafficResize.onPointerDown}
          title="Drag to resize"
        />

        <div className="right-panel">
          <div className="right-header">
            <div className="tabs">
              <button
                className={rightTab === "inspector" ? "tab active" : "tab"}
                onClick={() => setRightTab("inspector")}
              >
                Inspector
              </button>
              <button
                className={rightTab === "autoresponder" ? "tab active" : "tab"}
                onClick={() => setRightTab("autoresponder")}
              >
                Autoresponder
                {activeScenario && <span className="live-dot" />}
              </button>
            </div>
          </div>

          <div className="right-content">
            <div className={rightTab === "inspector" ? "pane" : "pane hidden"}>
              <FlowInspector
                detail={detail}
                onMock={mockFromFlow}
                decode={decode}
                onLoadFull={() => setFullBody(true)}
              />
            </div>
            <div className={rightTab === "autoresponder" ? "pane" : "pane hidden"}>
              <AutoresponderPanel
                ar={autoresponder}
                onChange={saveAutoresponder}
                selectRuleId={selectRuleId}
              />
            </div>
          </div>
        </div>
      </main>

      <StatusBar
        running={running}
        port={settings.port}
        allowRemote={settings.allowRemote}
        flowCount={orderRef.current.length}
        activeScenario={activeScenario}
      />

      {caOpen && caInfo && (
        <CaDialog info={caInfo} onClose={() => setCaOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={saveSettings}
          columnOrder={columnOrder}
          onColumnOrderChange={setColumnOrder}
          running={running}
          onCaChanged={() => void api.caInfo().then(setCaInfo)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
