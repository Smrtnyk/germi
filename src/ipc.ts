import { invoke, Channel } from "@tauri-apps/api/core";

import type {
  AutoResponder,
  CaInfo,
  FlowDetail,
  FlowEvent,
  FlowSummary,
  MockResult,
  ProxySettings,
  RuleSet,
  TestInput,
  TestResult,
} from "./types";

/** Typed wrappers around the Tauri commands in `src-tauri/src/commands.rs`. */
export const api = {
  proxyStatus: () => invoke<boolean>("proxy_status"),
  startProxy: (port: number) => invoke<number>("start_proxy", { port }),
  stopProxy: () => invoke<void>("stop_proxy"),

  listFlows: () => invoke<FlowSummary[]>("list_flows"),
  getFlow: (id: string, decoded: boolean, full: boolean) =>
    invoke<FlowDetail | null>("get_flow", { id, decoded, full }),
  clearFlows: () => invoke<void>("clear_flows"),

  getAutoresponder: () => invoke<AutoResponder>("get_autoresponder"),
  setAutoresponder: (autoresponder: AutoResponder) =>
    invoke<void>("set_autoresponder", { autoresponder }),
  getSettings: () => invoke<ProxySettings>("get_settings"),
  setSettings: (settings: ProxySettings) =>
    invoke<void>("set_settings", { settings }),
  exportSettings: () => invoke<boolean>("export_settings"),
  importSettings: () => invoke<ProxySettings>("import_settings"),
  testRules: (rules: RuleSet, input: TestInput) =>
    invoke<TestResult>("test_rules", { rules, input }),
  mockFlows: (ids: string[], scenarioId: string | null) =>
    invoke<MockResult>("mock_flows", { ids, scenarioId }),

  importArchive: () => invoke<number>("import_archive"),
  pickFile: () => invoke<string | null>("pick_file"),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  saveSession: () => invoke<boolean>("save_session"),
  openSession: () => invoke<number>("open_session"),
  searchBodies: (
    pattern: string,
    side: "request" | "response" | "either",
    regex: boolean,
    candidates: string[] | null,
  ) => invoke<string[]>("search_bodies", { pattern, side, regex, candidates }),

  caInfo: () => invoke<CaInfo>("ca_info"),
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
): Channel<FlowEvent[]> {
  const channel = new Channel<FlowEvent[]>();
  channel.onmessage = onBatch;
  void invoke("subscribe_flows", { channel });
  return channel;
}
