import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useAppState, type RightMode, type RightTab } from "./appState";
import { hasFlowDrag } from "./dnd";
import type { CaInfo, FlowDetail, FlowSummary, ProxySettings } from "./types";
import { Toolbar } from "./components/Toolbar";
import { FilterChips } from "./components/FilterChips";
import { TrafficList } from "./components/TrafficList";
import { FlowInspector } from "./components/FlowInspector";
import { AutoresponderPanel, type AutoresponderPanelProps } from "./components/AutoresponderPanel";
import { CaDialog } from "./components/CaDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { Shortcuts } from "./components/Shortcuts";
import { ToastHost, ToastProvider } from "./toast";

type AppStateValue = ReturnType<typeof useAppState>;

function buildActions(s: AppStateValue): PaletteAction[] {
  const ar = s.ar.autoresponder;
  const actions: PaletteAction[] = [
    {
      id: "proxy",
      group: "Proxy",
      label: s.proxy.running ? "Stop proxy" : "Start proxy",
      disabled: s.proxy.busy,
      run: s.proxy.toggleProxy,
    },
    {
      id: "system-proxy",
      group: "Proxy",
      label: s.proxy.systemProxy ? "Disable system proxy" : "Enable system proxy",
      disabled: !s.proxy.running,
      run: s.proxy.toggleSystemProxy,
    },
    {
      id: "focus-filter",
      group: "Traffic",
      label: "Focus filter",
      shortcut: "/",
      run: () => s.filterInputRef.current?.focus(),
    },
    { id: "clear", group: "Traffic", label: "Clear traffic", run: s.requestClearTraffic },
    {
      id: "clear-selection",
      group: "Traffic",
      label: "Clear selection",
      run: s.selection.clearSelection,
    },
    {
      id: "delete-selected",
      group: "Traffic",
      label: "Delete selected requests",
      run: s.deleteSelected,
    },
    {
      id: "save",
      group: "Session",
      label: "Save session…",
      shortcut: "Ctrl/⌘ S",
      run: s.session.saveSession,
    },
    {
      id: "open",
      group: "Session",
      label: "Open… (.germi, HAR, SAZ)",
      shortcut: "Ctrl/⌘ O",
      run: s.requestOpenCapture,
    },
    {
      id: "show-inspector",
      group: "View",
      label: "Show Inspector",
      shortcut: "Ctrl/⌘ 1",
      run: () => s.setRightTab("inspector"),
    },
    {
      id: "show-auto",
      group: "View",
      label: "Show Autoresponder",
      shortcut: "Ctrl/⌘ 2",
      run: () => s.setRightTab("autoresponder"),
    },
    {
      id: "split",
      group: "View",
      label: s.rightMode === "split" ? "Use single panel" : "Split panels",
      run: () => s.setRightMode(s.rightMode === "split" ? "single" : "split"),
    },
    {
      id: "toggle-panel",
      group: "View",
      label: s.rightCollapsed ? "Show side panel" : "Hide side panel",
      run: () => s.setRightCollapsed(!s.rightCollapsed),
    },
    {
      id: "decode",
      group: "View",
      label: s.decode ? "Disable body decode" : "Enable body decode",
      run: () => s.setDecode((d) => !d),
    },
    {
      id: "settings",
      group: "App",
      label: "Open Settings…",
      run: () => s.settings.setSettingsOpen(true),
    },
    { id: "ca", group: "App", label: "CA certificate…", run: () => s.setCaOpen(true) },
  ];
  for (const sc of ar.scenarios) {
    actions.push({
      id: `scenario-${sc.id}`,
      group: "Scenarios",
      label: `Activate scenario: ${sc.name}`,
      disabled: sc.id === ar.activeScenarioId,
      run: () => s.ar.activateScenario(sc.id),
    });
  }
  if (ar.activeScenarioId !== null) {
    actions.push({
      id: "scenario-off",
      group: "Scenarios",
      label: "Autoresponder: turn off",
      run: () => s.ar.activateScenario(null),
    });
  }
  return actions;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function runModShortcut(
  e: KeyboardEvent,
  k: string,
  s: AppStateValue,
  setPaletteOpen: Dispatch<SetStateAction<boolean>>,
): boolean {
  switch (k) {
    case "k":
      setPaletteOpen((o) => !o);
      return true;
    case "f":
      s.filterInputRef.current?.focus();
      return true;
    case "s":
      void s.session.saveSession();
      return true;
    case "o":
      s.requestOpenCapture();
      return true;
    case "1":
      s.setRightTab("inspector");
      return true;
    case "2":
      s.setRightTab("autoresponder");
      return true;
    case "z":
    case "y":
      // Global undo/redo — pass through to CodeMirror / inputs when one is
      // focused so they keep their own native undo. The History panel always works.
      if (isTyping(e.target)) return false;
      if (k === "y" || e.shiftKey) s.history.redo();
      else s.history.undo();
      return true;
    default:
      return false;
  }
}

function handleShortcut(
  e: KeyboardEvent,
  s: AppStateValue,
  setPaletteOpen: Dispatch<SetStateAction<boolean>>,
  setCheatOpen: (v: boolean) => void,
) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === "a" && !isTyping(e.target)) {
      e.preventDefault();
      s.selectAllVisible();
      return;
    }
    if (runModShortcut(e, k, s, setPaletteOpen)) e.preventDefault();
    return;
  }
  if (isTyping(e.target)) return;
  if (e.key === "/") {
    e.preventDefault();
    s.filterInputRef.current?.focus();
  } else if (e.key === "?") {
    e.preventDefault();
    setCheatOpen(true);
  }
}

function RightPanelHeader({
  rightTab,
  setRightTab,
  split,
  setRightMode,
  activeScenario,
  onCollapse,
}: {
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  split: boolean;
  setRightMode: (mode: RightMode) => void;
  activeScenario: string | null;
  onCollapse: () => void;
}) {
  return (
    <div className="right-header">
      {!split && (
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
            onDragEnter={(e) => {
              if (hasFlowDrag(e.dataTransfer.types)) setRightTab("autoresponder");
            }}
          >
            Autoresponder
            {activeScenario && <span className="live-dot" />}
          </button>
        </div>
      )}
      {split && <span className="split-label">Inspector + Autoresponder</span>}
      <div className="spacer" />
      <button
        className={split ? "btn active small" : "btn ghost small"}
        title={split ? "Show one panel at a time" : "Show Inspector and Autoresponder together"}
        onClick={() => setRightMode(split ? "single" : "split")}
      >
        ⊟ Split
      </button>
      <button
        className="btn ghost small"
        title="Hide panel — widen the traffic list"
        onClick={onCollapse}
      >
        ⟩
      </button>
    </div>
  );
}

function RightPanel({
  rightTab,
  setRightTab,
  rightMode,
  setRightMode,
  activeScenario,
  onCollapse,
  inspector,
  auto,
}: {
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  rightMode: RightMode;
  setRightMode: (mode: RightMode) => void;
  activeScenario: string | null;
  onCollapse: () => void;
  inspector: {
    detail: FlowDetail | null;
    summary: FlowSummary | undefined;
    loading: boolean;
    decode: boolean;
    onMock: (detail: FlowDetail) => void;
    onLoadFull: () => void;
    selectedSummaries: FlowSummary[];
    onSelectOne: (id: string) => void;
    onMockMany: (ids: string[]) => void;
    onClearSelection: () => void;
  };
  auto: AutoresponderPanelProps;
}) {
  const split = rightMode === "split";
  const inspectorVisible = split || rightTab === "inspector";
  const autoVisible = split || rightTab === "autoresponder";

  return (
    <div className="right-panel">
      <RightPanelHeader
        rightTab={rightTab}
        setRightTab={setRightTab}
        split={split}
        setRightMode={setRightMode}
        activeScenario={activeScenario}
        onCollapse={onCollapse}
      />

      <div className={`right-content ${split ? "split" : ""}`}>
        <div className={inspectorVisible ? "pane" : "pane hidden"}>
          <FlowInspector {...inspector} />
        </div>
        <div className={autoVisible ? "pane" : "pane hidden"}>
          <AutoresponderPanel {...auto} />
        </div>
      </div>
    </div>
  );
}

function PanelRail({
  activeScenario,
  onExpand,
}: {
  activeScenario: string | null;
  onExpand: () => void;
}) {
  return (
    <div className="panel-rail">
      <button className="rail-btn" onClick={onExpand} title="Show Inspector / Autoresponder panel">
        ⟨{activeScenario && <span className="live-dot" />}
        <span className="rail-label">Panel</span>
      </button>
    </div>
  );
}

function AppDialogs({
  caOpen,
  caInfo,
  onCaClose,
  settingsOpen,
  settings,
  onSettingsChange,
  onSettingsImported,
  columnOrder,
  onColumnOrderChange,
  running,
  onCaChanged,
  onSettingsClose,
}: {
  caOpen: boolean;
  caInfo: CaInfo | null;
  onCaClose: () => void;
  settingsOpen: boolean;
  settings: ProxySettings;
  onSettingsChange: (s: ProxySettings) => void;
  onSettingsImported: (s: ProxySettings) => void;
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  running: boolean;
  onCaChanged: () => void;
  onSettingsClose: () => void;
}) {
  return (
    <>
      {caOpen && caInfo && <CaDialog info={caInfo} onClose={onCaClose} />}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={onSettingsChange}
          onImportApplied={onSettingsImported}
          columnOrder={columnOrder}
          onColumnOrderChange={onColumnOrderChange}
          running={running}
          onCaChanged={onCaChanged}
          onClose={onSettingsClose}
        />
      )}
    </>
  );
}

export function App() {
  const s = useAppState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);

  const actions = useMemo(() => buildActions(s), [s]);

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => handleShortcut(e, s, setPaletteOpen, setCheatOpen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <ToastProvider value={s.notify}>
      <div className="app">
        <Toolbar
          running={s.proxy.running}
          busy={s.proxy.busy}
          port={s.settings.settings.port}
          onPortChange={(p) => s.saveSettings({ ...s.settings.settings, port: p })}
          onToggleProxy={s.proxy.toggleProxy}
          systemProxy={s.proxy.systemProxy}
          onToggleSystemProxy={s.proxy.toggleSystemProxy}
          onInstallCa={() => s.setCaOpen(true)}
          decode={s.decode}
          onToggleDecode={() => s.setDecode((d) => !d)}
          onOpenSettings={() => s.settings.setSettingsOpen(true)}
          onOpen={s.requestOpenCapture}
          onSaveSession={s.session.saveSession}
          onClear={s.requestClearTraffic}
          filter={s.filtering.filter}
          onFilterChange={s.filtering.setFilter}
          filterInputRef={s.filterInputRef}
        />

        <main
          className="body workbench"
          style={{
            gridTemplateColumns: s.rightCollapsed
              ? "minmax(0, 1fr) 0 36px"
              : `minmax(0, ${s.trafficSplit.leftPx}px) 6px minmax(440px, 1fr)`,
          }}
        >
          <div className="traffic-col">
            <FilterChips
              typeChips={s.filtering.typeChips}
              statusChips={s.filtering.statusChips}
              onToggleType={s.filtering.toggleTypeChip}
              onToggleStatus={s.filtering.toggleStatusChip}
              onClearAll={s.filtering.resetFilter}
              filter={s.filtering.filter}
              onFilterChange={s.filtering.setFilter}
              searching={s.filtering.searching}
              matchCount={s.matchCount}
              total={s.flowStore.flows.length}
            />
            <TrafficList
              flows={s.flowStore.flows}
              columns={s.columns.visibleColumns}
              matchedIds={s.filtering.matchedIds}
              selectedId={s.selection.selectedId}
              selectedIds={s.selection.selectedIds}
              onRowClick={s.handleRowClick}
              onKeySelect={s.handleKeySelect}
              onClearSelection={s.selection.clearSelection}
              onDeleteSelected={s.deleteSelected}
              onCommentEdit={s.flowStore.editComment}
              onMockFlow={s.mockFlow}
              onFilterToHost={s.filterToHost}
              onExcludeHost={s.excludeHost}
              onCopyCurl={s.copyFlowAsCurl}
              onCopyBody={s.copyFlowBody}
            />
          </div>

          <div
            className="resizer"
            onPointerDown={s.rightCollapsed ? undefined : s.trafficSplit.onPointerDown}
            title="Drag to resize"
          />

          {s.rightCollapsed ? (
            <PanelRail
              activeScenario={s.activeScenario}
              onExpand={() => s.setRightCollapsed(false)}
            />
          ) : (
            <RightPanel
              rightTab={s.rightTab}
              setRightTab={s.setRightTab}
              rightMode={s.rightMode}
              setRightMode={s.setRightMode}
              activeScenario={s.activeScenario}
              onCollapse={() => s.setRightCollapsed(true)}
              inspector={{
                detail: s.inspector.detail,
                summary: s.selectedSummary,
                loading: s.inspector.loading,
                decode: s.decode,
                onMock: (d) => void s.ar.mockFlows([d.id], s.ar.autoresponder.activeScenarioId),
                onLoadFull: () => s.setFullBody(true),
                selectedSummaries: s.selectedSummaries,
                onSelectOne: (id) => s.handleKeySelect(id, false),
                onMockMany: (ids) => {
                  void s.ar.mockFlows(ids, s.ar.autoresponder.activeScenarioId).then((ok) => {
                    if (ok) s.selection.clearSelection();
                  });
                },
                onClearSelection: s.selection.clearSelection,
              }}
              auto={{
                ar: s.ar.autoresponder,
                scenarioActions: {
                  activate: s.ar.activateScenario,
                  create: s.ar.createScenario,
                  rename: s.ar.renameScenario,
                  delete: s.ar.deleteScenario,
                  resetState: s.ar.resetRuleState,
                },
                ruleActions: {
                  create: s.ar.createRule,
                  load: s.ar.loadRule,
                  update: s.ar.updateRule,
                  delete: s.ar.deleteRule,
                  duplicate: s.ar.duplicateRule,
                  reorder: s.ar.reorderRule,
                },
                transferActions: {
                  exportRules: s.ar.exportRules,
                  importRules: s.ar.importRules,
                  dropMock: s.dropMockFlows,
                },
                selectRuleId: s.ar.selectRuleId,
                ruleHits: s.ar.ruleHits,
                bulkMockProgress: s.ar.bulkMockProgress,
                reloadToken: s.history.version,
              }}
            />
          )}
        </main>

        <StatusBar
          running={s.proxy.running}
          port={s.settings.settings.port}
          allowRemote={s.settings.settings.allowRemote}
          flowCount={s.flowStore.orderRef.current.length}
          activeScenario={s.activeScenario}
          onOpenPalette={() => setPaletteOpen(true)}
          onShowShortcuts={() => setCheatOpen(true)}
        />

        <AppDialogs
          caOpen={s.caOpen}
          caInfo={s.caInfo}
          onCaClose={() => s.setCaOpen(false)}
          settingsOpen={s.settings.settingsOpen}
          settings={s.settings.settings}
          onSettingsChange={s.saveSettings}
          onSettingsImported={s.applyImportedSettings}
          columnOrder={s.columns.columnOrder}
          onColumnOrderChange={s.columns.setColumnOrder}
          running={s.proxy.running}
          onCaChanged={s.refreshCa}
          onSettingsClose={() => s.settings.setSettingsOpen(false)}
        />

        {s.confirmClear && (
          <ConfirmDialog
            title="Clear all captured traffic?"
            message={`Permanently discard all ${s.flowStore.orderRef.current.length} captured flow(s)? Traffic is never auto-saved, so this can't be undone — use Save first if you want to keep it.`}
            confirmLabel="Clear traffic"
            danger
            onConfirm={s.confirmClearTraffic}
            onCancel={() => s.setConfirmClear(false)}
          />
        )}

        {s.confirmOpen && (
          <ConfirmDialog
            title="Open a file and replace current traffic?"
            message={`Opening a capture replaces all ${s.flowStore.orderRef.current.length} captured flow(s). Traffic is never auto-saved, so this can't be undone — use Save first if you want to keep it.`}
            confirmLabel="Open…"
            onConfirm={s.confirmOpenCapture}
            onCancel={() => s.setConfirmOpen(false)}
          />
        )}

        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {cheatOpen && <Shortcuts onClose={() => setCheatOpen(false)} />}
      </div>

      <ToastHost toasts={s.toasts} onDismiss={s.dismissToast} />
    </ToastProvider>
  );
}
