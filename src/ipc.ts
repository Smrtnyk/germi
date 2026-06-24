import { invoke, Channel } from "@tauri-apps/api/core";

import type {
  AutoResponderSummary,
  BulkMockEvent,
  CaInfo,
  FlowDetail,
  FlowEvent,
  FlowSummary,
  HistoryTag,
  MockResult,
  ProxySettings,
  Rule,
  RuleSummary,
  ScenarioSummary,
  TestInput,
  TestResult,
} from "./types";

/** Typed wrappers around the Tauri commands in `src-tauri/src/commands.rs`. */
export const api = {
  proxyStatus: () => invoke<boolean>("proxy_status"),
  startProxy: (port: number, allowRemote: boolean) =>
    invoke<number>("start_proxy", { port, allowRemote }),
  stopProxy: () => invoke<void>("stop_proxy"),

  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: string, decoded: boolean, full: boolean) =>
    invoke<FlowDetail | null>("get_flow", { id, decoded, full }),
  clearFlows: () => invoke<void>("clear_flows"),
  removeFlows: (ids: string[]) => invoke<void>("remove_flows", { ids }),
  setFlowComment: (id: string, comment: string | null) =>
    invoke<void>("set_flow_comment", { id, comment }),

  getAutoresponderSummary: () => invoke<AutoResponderSummary>("get_autoresponder_summary"),
  getRule: (ruleId: string) => invoke<Rule | null>("get_rule", { ruleId }),
  setActiveScenario: (scenarioId: string | null, historyTag: HistoryTag) =>
    invoke<void>("set_active_scenario", { scenarioId, historyTag }),
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
  duplicateRule: (scenarioId: string, ruleId: string, historyTag: HistoryTag) =>
    invoke<RuleSummary>("duplicate_rule", { scenarioId, ruleId, historyTag }),
  reorderRule: (scenarioId: string, ruleId: string, toId: string, historyTag: HistoryTag) =>
    invoke<void>("reorder_rule", { scenarioId, ruleId, toId, historyTag }),
  resetRuleState: (scenarioId: string | null) => invoke<void>("reset_rule_state", { scenarioId }),
  ruleHits: () => invoke<Record<string, number>>("rule_hits"),
  getSettings: () => invoke<ProxySettings>("get_settings"),
  setSettings: (settings: ProxySettings) => invoke<void>("set_settings", { settings }),
  exportSettings: () => invoke<boolean>("export_settings"),
  importSettings: () => invoke<ProxySettings>("import_settings"),
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

  pickFile: () => invoke<string | null>("pick_file"),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  saveSession: () => invoke<boolean>("save_session"),
  openCapture: () => invoke<number | null>("open_capture"),
  exportRules: (scenarioId: string | null) => invoke<boolean>("export_rules", { scenarioId }),
  importRules: (replace: boolean, historyTag: HistoryTag) =>
    invoke<number>("import_rules", { replace, historyTag }),

  historyUndo: () => invoke<void>("history_undo"),
  historyRedo: () => invoke<void>("history_redo"),
  searchBodies: (
    pattern: string,
    side: "request" | "response" | "either",
    regex: boolean,
    candidates: string[] | null,
  ) => invoke<string[]>("search_bodies", { pattern, side, regex, candidates }),

  caInfo: () => invoke<CaInfo>("ca_info"),
  exportCa: () => invoke<boolean>("export_ca"),
  regenerateCa: () => invoke<void>("regenerate_ca"),
  setSystemProxy: (port: number) => invoke<void>("set_system_proxy", { port }),
  clearSystemProxy: () => invoke<void>("clear_system_proxy"),
};

/**
 * Open the live flow stream. The backend pushes batches of events (~every 60ms
 * or 200 events) over a single long-lived channel. Returns the channel so the
 * caller can null its `onmessage` on unmount (see the Tauri channel leak note).
 */
export function subscribeFlows(
  onBatch: (events: FlowEvent[]) => void,
  onError?: (message: string) => void,
): Channel<FlowEvent[]> {
  const channel = new Channel<FlowEvent[]>();
  channel.onmessage = onBatch;
  invoke("subscribe_flows", { channel }).catch((e) => onError?.(String(e)));
  return channel;
}
