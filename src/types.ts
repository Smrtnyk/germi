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

export type AvailabilityVerdict = "public" | "protected" | "notFound" | "error" | "unknown";

export interface Availability {
  verdict: AvailabilityVerdict;
  /** Status code from the credential-stripped re-fetch (null on network error). */
  status: number | null;
  /** For a redirect, where it pointed (often a login page); null otherwise. */
  location: string | null;
}

export interface FlowSummary {
  id: string;
  /** Monotonic request number for the leading `#` column; assigned in arrival
   *  order on capture/import, renumbered from 1 on a fresh import (issue #75). */
  seq: number;
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
  /** Time-to-first-byte in ms (request-buffered → response-headers). */
  ttfbMs: number | null;
  matchedRule: string | null;
  timestampMs: number;
  /** User note/tag for triage. */
  comment: string | null;
  /** Public-availability verdict for a checked doc flow (drives the 🔓/🔒 icon);
   *  null until checked on demand. */
  availability: Availability | null;
  /** True when this flow was loaded from a file (HAR/SAZ/.germi) rather than
   *  captured live — drives the "imported" row marker and `is:imported` filter. */
  imported: boolean;
  /** Pinned header-column values, keyed by column spec (e.g. `cf-ray`, `req:referer`). */
  extra: Record<string, string>;
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
  /** True when decompression stopped at the 64 MiB cap (decoded body is incomplete). */
  decodeTruncated: boolean;
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
  | { type: "cleared" }
  | { type: "removed"; ids: string[] }
  | { type: "resync" };

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
      /**
       * Optional Content-Encoding applied to the served body on the wire
       * (e.g. "gzip" / "br" / "deflate"). When set, `body` is stored decoded
       * (editable as text) and compressed at serve time. Mirrors the Rust
       * `Action::Respond::content_encoding` field. Optional for back-compat
       * with older persisted rules (treated as identity / `null`).
       */
      contentEncoding: string | null;
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
  fireLimit: number | null;
  repeat: boolean;
  matcher: Matcher;
  action: Action;
}

export type ActionSummary =
  | { kind: "respond"; status: number; contentType: string | null; contentEncoding: string | null }
  | { kind: "mapLocal"; status: number }
  | { kind: "block" }
  | { kind: "setRequestHeader"; name: string }
  | { kind: "setResponseHeader"; name: string }
  | { kind: "setStatus"; status: number }
  | { kind: "rewriteResponseBody" };

export interface RuleSummary {
  id: string;
  name: string;
  enabled: boolean;
  fireLimit: number | null;
  repeat: boolean;
  matcher: Matcher;
  action: ActionSummary;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  rules: RuleSummary[];
}

export interface AutoResponderSummary {
  scenarios: ScenarioSummary[];
  /** Id of the active scenario, or null for Off (passthrough). */
  activeScenarioId: string | null;
}

/** Which rule fields `searchRules` scans (mirrors proxy-core `RuleSearchScope`). */
export type RuleSearchScope = "name" | "url" | "method" | "status" | "response" | "headers" | "all";

export interface ProxySettings {
  /** Host patterns tunneled without interception (no decrypt, no capture). */
  excludedHosts: string[];
  /** Pinned header columns: a header name (response) or `req:<name>` (request). */
  headerColumns: string[];
  // Connections
  port: number;
  allowRemote: boolean;
  // Capture
  maxFlows: number;
  captureFilter: string[];
  captureOnStart: boolean;
  // Throttling
  responseDelayMs: number;
  // Shortcuts
  systemProxyHotkey: string;
}

export interface CaInfo {
  certPem: string;
  certPath: string;
  dir: string;
}

export interface MockResult {
  scenarioId: string;
  newRuleIds: string[];
}

/** Progress for an in-flight doc public-availability check (per-flow verdicts
 *  arrive on the live flow stream; this is just the running count). */
export interface AvailabilityProgress {
  completed: number;
  total: number;
}

export type BulkMockEvent =
  | {
      type: "progress";
      completed: number;
      total: number;
      phase: "generating" | "saving";
    }
  | { type: "created"; scenarioId: string; rules: RuleSummary[] };

// ---- undo / redo history (mirror crates/proxy-core/src/history.rs) ----

/**
 * Metadata the frontend attaches to a mock mutation. `coalesceKey` merges
 * consecutive same-key edits into one undo step (e.g. typing a rule name); omit
 * it (or use a fresh key) to force a discrete entry.
 */
export interface HistoryTag {
  label: string;
  coalesceKey?: string | null;
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

export interface SequenceStep {
  outcome: string;
  status: number | null;
  rule: string | null;
}

export interface TestResult {
  matchedRules: string[];
  outcome: "respond" | "block" | "continue";
  shortCircuit: boolean;
  firedRule: string | null;
  effectiveRequestHeaders: [string, string][];
  response: TestResponse | null;
  notes: string[];
  sequence: SequenceStep[];
  sequenceLoops: boolean;
}
