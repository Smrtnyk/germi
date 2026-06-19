import { useAppState, type RightTab } from "./appState";
import type { AutoResponder, CaInfo, FlowDetail, FlowSummary, ProxySettings } from "./types";
import { Toolbar } from "./components/Toolbar";
import { FilterChips } from "./components/FilterChips";
import { TrafficList } from "./components/TrafficList";
import { FlowInspector } from "./components/FlowInspector";
import { AutoresponderPanel } from "./components/AutoresponderPanel";
import { CaDialog } from "./components/CaDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";

function ErrorBar({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="error-bar" onClick={onDismiss}>
      {error} <span className="dismiss">(dismiss)</span>
    </div>
  );
}

function SelectionBar({
  flows,
  selectedIds,
  setSelectedIds,
  autoresponder,
  pickScenarioId,
  setPickScenarioId,
  onMock,
}: {
  flows: FlowSummary[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  autoresponder: AutoResponder;
  pickScenarioId: string;
  setPickScenarioId: (id: string) => void;
  onMock: (ids: string[], scenarioId: string | null) => Promise<boolean>;
}) {
  if (selectedIds.size < 2) return null;

  const pick =
    pickScenarioId || autoresponder.activeScenarioId || autoresponder.scenarios[0]?.id || "__new__";

  async function addToScenario() {
    const ids = flows.filter((f) => selectedIds.has(f.id)).map((f) => f.id);
    if (ids.length === 0) return;
    const ok = await onMock(ids, pick === "__new__" ? null : pick);
    if (ok) {
      setSelectedIds(new Set());
      setPickScenarioId("");
    }
  }

  return (
    <div className="selection-bar">
      <span>
        <strong>{selectedIds.size}</strong> selected
      </span>
      <select value={pick} onChange={(e) => setPickScenarioId(e.target.value)}>
        {autoresponder.scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value="__new__">+ New scenario</option>
      </select>
      <button className="btn primary" onClick={addToScenario}>
        Add to scenario
      </button>
      <button className="btn" onClick={() => setSelectedIds(new Set())}>
        Clear
      </button>
    </div>
  );
}

function RightPanel({
  rightTab,
  setRightTab,
  activeScenario,
  detail,
  decode,
  onMock,
  onLoadFull,
  autoresponder,
  onAutoresponderChange,
  selectRuleId,
}: {
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  activeScenario: string | null;
  detail: FlowDetail | null;
  decode: boolean;
  onMock: (detail: FlowDetail) => void;
  onLoadFull: () => void;
  autoresponder: AutoResponder;
  onAutoresponderChange: (ar: AutoResponder) => void;
  selectRuleId: string | null;
}) {
  return (
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
          <FlowInspector detail={detail} onMock={onMock} decode={decode} onLoadFull={onLoadFull} />
        </div>
        <div className={rightTab === "autoresponder" ? "pane" : "pane hidden"}>
          <AutoresponderPanel
            ar={autoresponder}
            onChange={onAutoresponderChange}
            selectRuleId={selectRuleId}
          />
        </div>
      </div>
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

  return (
    <div className="app">
      <Toolbar
        running={s.proxy.running}
        port={s.settings.settings.port}
        onPortChange={(p) => s.saveSettings({ ...s.settings.settings, port: p })}
        onToggleProxy={s.proxy.toggleProxy}
        systemProxy={s.proxy.systemProxy}
        onToggleSystemProxy={s.proxy.toggleSystemProxy}
        onInstallCa={() => s.setCaOpen(true)}
        onImport={s.session.importArchive}
        decode={s.decode}
        onToggleDecode={() => s.setDecode((d) => !d)}
        onOpenSettings={() => s.settings.setSettingsOpen(true)}
        onOpenSession={s.session.openSession}
        onSaveSession={s.session.saveSession}
        onClear={s.clearTraffic}
        filter={s.filtering.filter}
        onFilterChange={s.filtering.setFilter}
      />

      <ErrorBar error={s.error} onDismiss={() => s.setError(null)} />

      <main
        className="body workbench"
        style={{
          gridTemplateColumns: `minmax(0, ${s.trafficResize.size}px) 6px minmax(440px, 1fr)`,
        }}
      >
        <div className="traffic-col">
          <FilterChips
            typeChips={s.filtering.typeChips}
            statusChips={s.filtering.statusChips}
            onToggleType={s.filtering.toggleTypeChip}
            onToggleStatus={s.filtering.toggleStatusChip}
            searching={s.filtering.searching}
            matchCount={s.matchCount}
            total={s.flowStore.flows.length}
          />
          <SelectionBar
            flows={s.flowStore.flows}
            selectedIds={s.selection.selectedIds}
            setSelectedIds={s.selection.setSelectedIds}
            autoresponder={s.ar.autoresponder}
            pickScenarioId={s.ar.pickScenarioId}
            setPickScenarioId={s.ar.setPickScenarioId}
            onMock={s.ar.mockFlows}
          />
          <TrafficList
            flows={s.flowStore.flows}
            columns={s.columns.visibleColumns}
            matchedIds={s.filtering.matchedIds}
            selectedId={s.selection.selectedId}
            selectedIds={s.selection.selectedIds}
            onRowClick={s.handleRowClick}
            onContentWidth={s.setTrafficMin}
            onCommentEdit={s.flowStore.editComment}
          />
        </div>

        <div
          className="resizer"
          onPointerDown={s.trafficResize.onPointerDown}
          title="Drag to resize"
        />

        <RightPanel
          rightTab={s.rightTab}
          setRightTab={s.setRightTab}
          activeScenario={s.activeScenario}
          detail={s.inspector.detail}
          decode={s.decode}
          onMock={(d) => void s.ar.mockFlows([d.id], s.ar.autoresponder.activeScenarioId)}
          onLoadFull={() => s.setFullBody(true)}
          autoresponder={s.ar.autoresponder}
          onAutoresponderChange={s.ar.saveAutoresponder}
          selectRuleId={s.ar.selectRuleId}
        />
      </main>

      <StatusBar
        running={s.proxy.running}
        port={s.settings.settings.port}
        allowRemote={s.settings.settings.allowRemote}
        flowCount={s.flowStore.orderRef.current.length}
        activeScenario={s.activeScenario}
      />

      <AppDialogs
        caOpen={s.caOpen}
        caInfo={s.caInfo}
        onCaClose={() => s.setCaOpen(false)}
        settingsOpen={s.settings.settingsOpen}
        settings={s.settings.settings}
        onSettingsChange={s.saveSettings}
        columnOrder={s.columns.columnOrder}
        onColumnOrderChange={s.columns.setColumnOrder}
        running={s.proxy.running}
        onCaChanged={s.refreshCa}
        onSettingsClose={() => s.settings.setSettingsOpen(false)}
      />
    </div>
  );
}
