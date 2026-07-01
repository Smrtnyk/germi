import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useAppState, type RightMode, type RightTab } from "./appState";
import {
  accelFromEvent,
  prettyShortcut,
  reverseLookup,
  type Accel,
  type CommandId,
} from "./shortcuts";
import { hasFlowDrag } from "./dnd";
import type { CaInfo, FlowDetail, FlowSummary } from "./types";
import { Toolbar } from "./components/Toolbar";
import { FilterChips } from "./components/FilterChips";
import { TrafficList } from "./components/TrafficList";
import { FlowInspector } from "./components/FlowInspector";
import { AutoresponderPanel, type AutoresponderPanelProps } from "./components/AutoresponderPanel";
import { CaDialog } from "./components/CaDialog";
import { SettingsDialog, type SettingsDialogProps } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { IconPanelCollapse, IconPanelExpand, IconSearch, IconSplit } from "./components/icons";
import { Shortcuts } from "./components/Shortcuts";
import { ToastHost, ToastProvider } from "./toast";

type AppStateValue = ReturnType<typeof useAppState>;

function buildActions(s: AppStateValue): PaletteAction[] {
  const ar = s.ar.autoresponder;
  // The proxy is disabled in viewer mode, so its commands don't apply there.
  const proxyActions: PaletteAction[] = s.viewer
    ? []
    : [
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
      ];
  // The autoresponder is disabled in viewer mode — drop its view commands too.
  const autoViewActions: PaletteAction[] = s.viewer
    ? []
    : [
        {
          id: "show-auto",
          group: "View",
          label: "Show Autoresponder",
          shortcut: prettyShortcut(s.shortcuts["show-autoresponder"]),
          run: () => s.setRightTab("autoresponder"),
        },
        {
          id: "split",
          group: "View",
          label: s.rightMode === "split" ? "Use single panel" : "Split panels",
          run: () => s.setRightMode(s.rightMode === "split" ? "single" : "split"),
        },
      ];
  const actions: PaletteAction[] = [
    ...proxyActions,
    {
      id: "focus-filter",
      group: "Traffic",
      label: "Focus filter",
      shortcut: prettyShortcut(s.shortcuts["focus-filter"]),
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
      id: "delete-captured",
      group: "Traffic",
      label: "Delete captured requests (keep imported)",
      run: s.deleteCaptured,
    },
    {
      id: "save",
      group: "Session",
      label: "Save session…",
      shortcut: prettyShortcut(s.shortcuts.save),
      run: s.session.saveSession,
    },
    {
      id: "open",
      group: "Session",
      label: "Open… (.germi, HAR, SAZ)",
      shortcut: prettyShortcut(s.shortcuts.open),
      run: s.requestOpenCapture,
    },
    {
      id: "show-inspector",
      group: "View",
      label: "Show Inspector",
      shortcut: prettyShortcut(s.shortcuts["show-inspector"]),
      run: () => s.setRightTab("inspector"),
    },
    ...autoViewActions,
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
    { id: "new-viewer", group: "App", label: "New viewer window", run: s.launchViewer },
  ];
  if (s.viewer) return actions;
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

function commandActions(
  s: AppStateValue,
  setPaletteOpen: Dispatch<SetStateAction<boolean>>,
): Record<CommandId, () => void> {
  return {
    palette: () => setPaletteOpen((o) => !o),
    "focus-filter": () => focusSearch(s),
    save: () => void s.session.saveSession(),
    open: () => s.requestOpenCapture(),
    "copy-url": () => s.copySelectedUrl(),
    "show-inspector": () => s.setRightTab("inspector"),
    // The autoresponder is disabled in viewer mode, so these are no-ops there.
    "show-autoresponder": () => {
      if (!s.viewer) s.setRightTab("autoresponder");
    },
    "edit-mock-body": () => {
      if (!s.viewer) s.focusMockBody();
    },
  };
}

function elClosest(node: Node | EventTarget | null, selector: string): boolean {
  const n = node as Node | null;
  const el = n && n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element | null);
  return !!el?.closest?.(selector);
}

function findRegion(): "url" | "headers" | "body" | null {
  const anchor = window.getSelection()?.anchorNode ?? null;
  if (elClosest(anchor, ".req-url")) return "url";
  if (elClosest(anchor, ".meta-scroll")) return "headers";
  if (elClosest(anchor, ".vtext")) return "body";
  return null;
}

function focusSearch(s: AppStateValue): void {
  const active = document.activeElement;
  if (isTyping(active) && elClosest(active, ".autoresponder")) return;
  const region = findRegion();
  if (region === "url") {
    const sel = window.getSelection()?.toString().trim() ?? "";
    if (sel) s.filtering.setFilter(sel);
    s.filterInputRef.current?.focus();
    return;
  }
  const find = s.inspectorFindRef.current;
  if (find && region) {
    const sel = window.getSelection()?.toString().trim() ?? "";
    find.openFind(sel || undefined, region === "headers" ? "headers" : "body");
    return;
  }
  s.filterInputRef.current?.focus();
}

// Fixed Ctrl/⌘ combos that aren't user-rebindable: select-all and undo/redo.
// Other Mod combos (copy / paste / cut, …) fall through to the browser.
function handleModShortcut(e: KeyboardEvent, s: AppStateValue) {
  const k = e.key.toLowerCase();
  if (k === "a" && !isTyping(e.target)) {
    e.preventDefault();
    s.selectAllVisible();
    return;
  }
  // Undo/redo — pass through to CodeMirror / inputs when one is focused so they
  // keep their native undo. The History panel always works otherwise.
  if ((k === "z" || k === "y") && !isTyping(e.target)) {
    if (k === "y" || e.shiftKey) s.history.redo();
    else s.history.undo();
    e.preventDefault();
  }
}

function handleFindNav(e: KeyboardEvent, s: AppStateValue): void {
  const find = s.inspectorFindRef.current;
  if (!find) return;
  e.preventDefault();
  if (find.open) find.step(e.shiftKey ? -1 : 1);
  else find.openFind();
}

function handleShortcut(
  e: KeyboardEvent,
  s: AppStateValue,
  reverse: Map<Accel, CommandId>,
  actions: Record<CommandId, () => void>,
  setCheatOpen: (v: boolean) => void,
) {
  // Configurable commands run first; only their accels live in `reverse`, so the
  // fixed combos keep their exact semantics. All eight fire even while typing
  // (e.g. Ctrl+S in the filter), matching the previous behavior.
  const accel = accelFromEvent(e);
  const cmd = accel ? reverse.get(accel) : undefined;
  if (cmd) {
    e.preventDefault();
    actions[cmd]();
    return;
  }
  if (e.key === "F3") {
    handleFindNav(e, s);
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    handleModShortcut(e, s);
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
  onOpenFind,
}: {
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  split: boolean;
  setRightMode: (mode: RightMode) => void;
  activeScenario: string | null;
  onCollapse: () => void;
  onOpenFind: () => void;
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
      {(split || rightTab === "inspector") && (
        <button
          className="btn ghost small"
          title="Search the inspected request & response (Ctrl/⌘ F)"
          onClick={onOpenFind}
        >
          <IconSearch /> Search
        </button>
      )}
      <button
        className={split ? "btn active small" : "btn ghost small"}
        title={split ? "Show one panel at a time" : "Show Inspector and Autoresponder together"}
        onClick={() => setRightMode(split ? "single" : "split")}
      >
        <IconSplit /> Split
      </button>
      <button
        className="btn ghost small"
        title="Hide panel — widen the traffic list"
        onClick={onCollapse}
      >
        <IconPanelCollapse />
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
  viewer,
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
    inspectorFindRef: AppStateValue["inspectorFindRef"];
  };
  auto: AutoresponderPanelProps;
  viewer: boolean;
}) {
  // Viewer mode disables the autoresponder entirely: an Inspector-only panel,
  // no tabs / split / autoresponder pane.
  if (viewer) {
    return (
      <div className="right-panel">
        <div className="right-header">
          <span className="split-label">Inspector</span>
          <div className="spacer" />
          <button
            className="btn ghost small"
            title="Search the inspected request & response (Ctrl/⌘ F)"
            onClick={() => inspector.inspectorFindRef.current?.openFind(undefined, "body")}
          >
            <IconSearch /> Search
          </button>
          <button
            className="btn ghost small"
            title="Hide panel — widen the traffic list"
            onClick={onCollapse}
          >
            <IconPanelCollapse />
          </button>
        </div>
        <div className="right-content">
          <div className="pane">
            <FlowInspector {...inspector} viewer />
          </div>
        </div>
      </div>
    );
  }

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
        onOpenFind={() => inspector.inspectorFindRef.current?.openFind(undefined, "body")}
      />

      <div className={`right-content ${split ? "split" : ""}`}>
        <div className={inspectorVisible ? "pane" : "pane hidden"}>
          <FlowInspector {...inspector} viewer={false} />
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
  viewer,
}: {
  activeScenario: string | null;
  onExpand: () => void;
  viewer: boolean;
}) {
  return (
    <div className="panel-rail">
      <button className="rail-btn" onClick={onExpand} title="Show Inspector / Autoresponder panel">
        <IconPanelExpand />
        {!viewer && activeScenario && <span className="live-dot" />}
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
  settingsProps,
}: {
  caOpen: boolean;
  caInfo: CaInfo | null;
  onCaClose: () => void;
  settingsOpen: boolean;
  settingsProps: SettingsDialogProps;
}) {
  return (
    <>
      {caOpen && caInfo && <CaDialog info={caInfo} onClose={onCaClose} />}
      {settingsOpen && <SettingsDialog {...settingsProps} />}
    </>
  );
}

export function App() {
  const s = useAppState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);

  const actions = useMemo(() => buildActions(s), [s]);
  const reverse = useMemo(() => reverseLookup(s.shortcuts), [s.shortcuts]);
  const cmdActions = commandActions(s, setPaletteOpen);

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => handleShortcut(e, s, reverse, cmdActions, setCheatOpen);

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
          onToggleProxy={s.proxy.toggleProxy}
          systemProxy={s.proxy.systemProxy}
          onToggleSystemProxy={s.proxy.toggleSystemProxy}
          viewer={s.viewer}
          onLaunchViewer={s.launchViewer}
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
              onCheckAvailability={s.checkAvailability}
              availabilityCheck={s.availabilityCheck}
              capturedDelete={{
                capturedCount: s.capturedCount,
                importedCount: s.importedCount,
                onDelete: s.deleteCaptured,
              }}
            />
            <TrafficList
              flows={s.flows}
              columns={s.columns.visibleColumns}
              sort={s.sort}
              onToggleSort={s.toggleSort}
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
              viewer={s.viewer}
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
              viewer={s.viewer}
            />
          ) : (
            <RightPanel
              rightTab={s.rightTab}
              setRightTab={s.setRightTab}
              rightMode={s.rightMode}
              setRightMode={s.setRightMode}
              activeScenario={s.activeScenario}
              onCollapse={() => s.setRightCollapsed(true)}
              viewer={s.viewer}
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
                inspectorFindRef: s.inspectorFindRef,
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
                layout: s.autoLayout,
                openWindowRuleIds: s.openRuleWindows,
                onOpenRuleWindow: s.openRuleWindow,
              }}
            />
          )}
        </main>

        <StatusBar
          running={s.proxy.running}
          port={s.proxy.listenPort}
          allowRemote={s.proxy.listenAllowRemote}
          viewer={s.viewer}
          flowCount={s.flowStore.orderRef.current.length}
          activeScenario={s.activeScenario}
          paletteAccel={prettyShortcut(s.shortcuts.palette)}
          onOpenPalette={() => setPaletteOpen(true)}
          onShowShortcuts={() => setCheatOpen(true)}
        />

        <AppDialogs
          caOpen={s.caOpen}
          caInfo={s.caInfo}
          onCaClose={() => s.setCaOpen(false)}
          settingsOpen={s.settings.settingsOpen}
          settingsProps={{
            settings: s.settings.settings,
            onChange: s.saveSettings,
            onImportApplied: s.applyImportedSettings,
            columnOrder: s.columns.columnOrder,
            onColumnOrderChange: s.columns.setColumnOrder,
            shortcuts: s.shortcuts,
            onShortcutsChange: s.setShortcuts,
            autoLayout: s.autoLayout,
            onAutoLayoutChange: s.setAutoLayout,
            running: s.proxy.running,
            portError: s.proxy.listenerError,
            onCaChanged: s.refreshCa,
            onClose: () => {
              s.settings.setSettingsOpen(false);
              s.proxy.clearListenerError();
            },
          }}
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
        {cheatOpen && <Shortcuts bindings={s.shortcuts} onClose={() => setCheatOpen(false)} />}
      </div>

      <ToastHost toasts={s.toasts} onDismiss={s.dismissToast} />
    </ToastProvider>
  );
}
