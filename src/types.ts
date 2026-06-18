// These mirror the serde DTOs in `crates/proxy-core` (all camelCase).

export type ResourceKind =
  | "doc"
  | "xhr"
  | "js"
  | "css"
  | "img"
  | "font"
  | "media"
  | "ws"
  | "wasm"
  | "other";

export interface FlowSummary {
  id: string;
  method: string;
  host: string;
  path: string;
  scheme: string;
  status: number | null;
  mime: string | null;
  /** Inferred resource type for the type chips (best-effort). */
  kind: ResourceKind;
  reqSize: number;
  respSize: number;
  durationMs: number | null;
  matchedRule: string | null;
  timestampMs: number;
}

export interface MessageDetail {
  headers: [string, string][];
  bodyText: string;
  bodyBase64: string;
  size: number;
  /** Original Content-Encoding (e.g. "gzip"), if the body was encoded. */
  encoding: string | null;
  /** Whether bodyText/bodyBase64 are the decompressed form. */
  decoded: boolean;
  /** True when the body was capped for display (refetch with full=true). */
  truncated: boolean;
}

export interface FlowDetail {
  id: string;
  method: string;
  uri: string;
  host: string;
  path: string;
  scheme: string;
  reqVersion: string;
  request: MessageDetail;
  status: number | null;
  respVersion: string | null;
  response: MessageDetail | null;
  matchedRule: string | null;
  durationMs: number | null;
  timestampMs: number;
}

export type FlowEvent =
  | { type: "new"; summary: FlowSummary }
  | { type: "completed"; summary: FlowSummary }
  | { type: "cleared" };

// ---- rules (mirror crates/proxy-core/src/rules.rs) ----

export type MatchKind = "contains" | "exact" | "regex";

export interface Matcher {
  method: string | null;
  url: string;
  urlMatch: MatchKind;
}

export type Action =
  | {
      kind: "respond";
      status: number;
      headers: [string, string][];
      body: string;
      contentType: string | null;
    }
  | { kind: "mapLocal"; path: string; status: number }
  | { kind: "block" }
  | { kind: "setRequestHeader"; name: string; value: string }
  | { kind: "setResponseHeader"; name: string; value: string }
  | { kind: "setStatus"; status: number }
  | { kind: "rewriteResponseBody"; find: string; replace: string; regex: boolean };

export type ActionKind = Action["kind"];

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  matcher: Matcher;
  action: Action;
}

export interface RuleSet {
  rules: Rule[];
}

/** A named, switchable group of rules. Exactly one scenario is active at a time. */
export interface Scenario {
  id: string;
  name: string;
  rules: Rule[];
}

export interface AutoResponder {
  scenarios: Scenario[];
  /** Id of the active scenario, or null for Off (passthrough). */
  activeScenarioId: string | null;
}

export interface ProxySettings {
  /** Host patterns tunneled without interception (no decrypt, no capture). */
  excludedHosts: string[];
}

export interface CaInfo {
  certPem: string;
  certPath: string;
  dir: string;
}

export interface MockResult {
  autoresponder: AutoResponder;
  newRuleIds: string[];
}

// ---- rule tester (mirror crates/proxy-core/src/tester.rs) ----

export interface TestInput {
  method: string;
  url: string;
  reqHeaders: [string, string][];
  reqBody: string;
  respStatus: number;
  respHeaders: [string, string][];
  respBody: string;
}

export interface TestResponse {
  status: number;
  headers: [string, string][];
  body: string;
  source: string;
}

export interface TestResult {
  matchedRules: string[];
  outcome: "respond" | "block" | "continue";
  shortCircuit: boolean;
  firedRule: string | null;
  effectiveRequestHeaders: [string, string][];
  response: TestResponse | null;
  notes: string[];
}
