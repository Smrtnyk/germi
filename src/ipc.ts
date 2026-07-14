import { invoke, Channel } from "@tauri-apps/api/core";

import type {
  AutoResponderSummary,
  AvailabilityProgress,
  BodyComparison,
  BoundAddr,
  BulkMockEvent,
  CaInfo,
  CompareSeed,
  FlowDetail,
  FlowEvent,
  FlowSummary,
  HistoryTag,
  MockResult,
  OpenedCapture,
  ProxySettings,
  Rule,
  RuleSearchScope,
  RuleSummary,
  ScenarioSummary,
  Script,
  ScriptDiagnostic,
  SettingsSectionSummary,
  SystemProxyStatus,
  TestInput,
  TestResult,
} from "./types";

/** Typed wrappers around the Tauri commands in `src-tauri/src/commands.rs`. */
export const api = {
  proxyStatus: () => invoke<boolean>("proxy_status"),
  boundAddr: () => invoke<BoundAddr | null>("bound_addr"),
  isViewerMode: () => invoke<boolean>("is_viewer_mode"),
  launchViewer: () => invoke<void>("launch_viewer"),
  startProxy: (port: number, allowRemote: boolean) =>
    invoke<number>("start_proxy", { port, allowRemote }),
  restartProxy: (port: number, allowRemote: boolean) =>
    invoke<number>("restart_proxy", { port, allowRemote }),
  stopProxy: () => invoke<void>("stop_proxy"),

  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: string, decoded: boolean, full: boolean) =>
    invoke<FlowDetail | null>("get_flow", { id, decoded, full }),
  clearFlows: () => invoke<void>("clear_flows"),
  removeFlows: (ids: string[]) => invoke<void>("remove_flows", { ids }),
  removeCapturedFlows: () => invoke<void>("remove_captured_flows"),
  setFlowComment: (id: string, comment: string | null) =>
    invoke<void>("set_flow_comment", { id, comment }),

  getAutoresponderSummary: () => invoke<AutoResponderSummary>("get_autoresponder_summary"),
  getRule: (ruleId: string) => invoke<Rule | null>("get_rule", { ruleId }),
  setActiveScenario: (scenarioId: string | null, historyTag: HistoryTag) =>
    invoke<void>("set_active_scenario", { scenarioId, historyTag }),
  setGeneralActive: (active: boolean, historyTag: HistoryTag) =>
    invoke<void>("set_general_active", { active, historyTag }),
  createScenario: (name: string | null, historyTag: HistoryTag) =>
    invoke<ScenarioSummary>("create_scenario", { name, historyTag }),
  renameScenario: (scenarioId: string, name: string, historyTag: HistoryTag) =>
    invoke<void>("rename_scenario", { scenarioId, name, historyTag }),
  deleteScenario: (scenarioId: string, historyTag: HistoryTag) =>
    invoke<void>("delete_scenario", { scenarioId, historyTag }),
  createRule: (scenarioId: string, historyTag: HistoryTag) =>
    invoke<RuleSummary>("create_rule", { scenarioId, historyTag }),
  updateRule: (scenarioId: string, rule: Rule, historyTag: HistoryTag) =>
    invoke<RuleSummary>("update_rule", { scenarioId, rule, historyTag }),
  deleteRule: (scenarioId: string, ruleId: string, historyTag: HistoryTag) =>
    invoke<void>("delete_rule", { scenarioId, ruleId, historyTag }),
  deleteRules: (scenarioId: string, ruleIds: string[], historyTag: HistoryTag) =>
    invoke<void>("delete_rules", { scenarioId, ruleIds, historyTag }),
  duplicateRule: (scenarioId: string, ruleId: string, historyTag: HistoryTag) =>
    invoke<RuleSummary>("duplicate_rule", { scenarioId, ruleId, historyTag }),
  reorderRule: (scenarioId: string, ruleId: string, toId: string, historyTag: HistoryTag) =>
    invoke<void>("reorder_rule", { scenarioId, ruleId, toId, historyTag }),
  resetRuleState: (scenarioId: string | null) => invoke<void>("reset_rule_state", { scenarioId }),
  ruleHits: () => invoke<Record<string, number>>("rule_hits"),
  getSettings: () => invoke<ProxySettings>("get_settings"),
  setSettings: (settings: ProxySettings) => invoke<void>("set_settings", { settings }),
  getSettingsSections: () => invoke<SettingsSectionSummary[]>("get_settings_sections"),
  exportSettings: (sections: string[]) => invoke<boolean>("export_settings", { sections }),
  peekSettingsImport: () => invoke<SettingsSectionSummary[] | null>("peek_settings_import"),
  applySettingsImport: (sections: string[]) =>
    invoke<ProxySettings>("apply_settings_import", { sections }),
  getScripts: () => invoke<Script[]>("get_scripts"),
  setScripts: (scripts: Script[]) => invoke<ScriptDiagnostic[]>("set_scripts", { scripts }),
  checkScript: (source: string) => invoke<string | null>("check_script", { source }),
  testScenario: (scenarioId: string, input: TestInput) =>
    invoke<TestResult>("test_scenario", { scenarioId, input }),
  mockFlows: (
    ids: string[],
    scenarioId: string | null,
    historyTag: HistoryTag,
    onProgress: (event: BulkMockEvent) => void,
  ) => {
    const progress = new Channel<BulkMockEvent>();
    progress.onmessage = onProgress;
    return invoke<MockResult>("mock_flows", { ids, scenarioId, historyTag, progress });
  },
  checkDocAvailability: (ids: string[], onProgress: (event: AvailabilityProgress) => void) => {
    const progress = new Channel<AvailabilityProgress>();
    progress.onmessage = onProgress;
    return invoke<number>("check_doc_availability", { ids, progress });
  },

  pickFile: () => invoke<string | null>("pick_file"),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  saveSession: (includeRules: boolean) => invoke<boolean>("save_session", { includeRules }),
  openCapture: () => invoke<OpenedCapture | null>("open_capture"),
  appendCapture: () => invoke<FlowSummary[] | null>("append_capture"),
  openDroppedCapture: (dataB64: string, ext: string) =>
    invoke<OpenedCapture>("open_dropped_capture", { dataB64, ext }),
  appendDroppedCapture: (dataB64: string, ext: string) =>
    invoke<FlowSummary[]>("append_dropped_capture", { dataB64, ext }),
  compareFlowBodies: (idA: string, idB: string) =>
    invoke<BodyComparison | null>("compare_flow_bodies", { idA, idB }),
  setCompareSeed: (seed: CompareSeed) => invoke<void>("set_compare_seed", { seed }),
  getCompareSeed: () => invoke<CompareSeed | null>("get_compare_seed"),
  exportRules: (scenarioId: string | null) => invoke<boolean>("export_rules", { scenarioId }),
  importRules: (replace: boolean, historyTag: HistoryTag) =>
    invoke<number>("import_rules", { replace, historyTag }),
  applyHarRules: (historyTag: HistoryTag) => invoke<number>("apply_har_rules", { historyTag }),

  historyUndo: () => invoke<void>("history_undo"),
  historyRedo: () => invoke<void>("history_redo"),
  searchBodies: (
    pattern: string,
    side: "request" | "response" | "either",
    regex: boolean,
    candidates: string[] | null,
  ) => invoke<string[]>("search_bodies", { pattern, side, regex, candidates }),
  searchHeaders: (
    pattern: string,
    side: "request" | "response" | "either",
    regex: boolean,
    candidates: string[] | null,
  ) => invoke<string[]>("search_headers", { pattern, side, regex, candidates }),
  searchRules: (scenarioId: string, pattern: string, scope: RuleSearchScope) =>
    invoke<string[]>("search_rules", { scenarioId, pattern, scope }),

  caInfo: () => invoke<CaInfo>("ca_info"),
  exportCa: () => invoke<boolean>("export_ca"),
  regenerateCa: () => invoke<void>("regenerate_ca"),
  setSystemProxy: (port: number) => invoke<void>("set_system_proxy", { port }),
  systemProxyStatus: () => invoke<SystemProxyStatus>("system_proxy_status"),
  clearSystemProxy: () => invoke<void>("clear_system_proxy"),
};

/**
 * Open the live flow stream. The backend pushes batches of events (~every 60ms
 * or 200 events) over a single long-lived channel. Returns both the channel
 * (for cleanup) and a promise that resolves only after the backend installed
 * the subscriber, closing the startup snapshot/event gap.
 */
export function subscribeFlows(
  onBatch: (events: FlowEvent[]) => void,
  onError?: (message: string) => void,
): { channel: Channel<FlowEvent[]>; ready: Promise<void> } {
  const channel = new Channel<FlowEvent[]>();
  channel.onmessage = onBatch;
  const ready = invoke<void>("subscribe_flows", { channel }).catch((error) => {
    onError?.(String(error));
    throw error;
  });
  return { channel, ready };
}
