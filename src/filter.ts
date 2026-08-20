import type { FlowSummary, ResourceKind } from "./types";

// ---- the token filter ----
//
// Grammar (DevTools-flavored): whitespace-separated terms = AND. A bare word,
// quoted phrase, or /regex/ searches one logical "all" projection: request URL
// OR request/response headers OR decoded request/response bodies. A leading `-`
// negates that whole OR result. `url:` is the explicit URL-only form.
// `content:` / `req-content:` / `resp-content:` search headers OR decoded body
// on the chosen side. body:, header:, and cookie: retain their narrower meaning.

export interface ContentTerm {
  field: "all" | "content" | "body" | "headers" | "cookies";
  side: "request" | "response" | "either";
  value: string;
  regex: boolean;
  neg: boolean;
}

type SummaryTerm =
  | { t: "text"; value: string; neg: boolean }
  | { t: "regex"; re: RegExp | null; neg: boolean }
  | { t: "url-text"; value: string; neg: boolean }
  | { t: "url-regex"; re: RegExp | null; neg: boolean }
  | { t: "kv"; key: string; value: string; neg: boolean };

export interface ParsedFilter {
  /** URL projection used by summary-only consumers such as Compare. */
  matchSummary: (s: FlowSummary) => boolean;
  /** Hard frontend constraints safe to apply before an all/content scan. */
  matchCandidates: (s: FlowSummary) => boolean;
  /** Content terms requiring a backend scan. Empty = no backend call needed. */
  contentTerms: ContentTerm[];
}

const SUMMARY_KEYS = new Set([
  "url",
  "method",
  "host",
  "domain",
  "path",
  "scheme",
  "status",
  "mime",
  "kind",
  "ext",
  "is",
  "rule",
  "matched",
  "larger-than",
  "smaller-than",
  "req-larger-than",
  "slower-than",
]);
const BODY_KEYS = new Set(["body", "req-body", "resp-body"]);
const HEADER_KEYS = new Set(["header", "req-header", "resp-header"]);
const COOKIE_KEYS = new Set(["cookie", "req-cookie", "resp-cookie"]);
const CONTENT_KEYS = new Set(["content", "req-content", "resp-content"]);

function skipSpaces(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

interface RawTerm {
  text: string;
  neg: boolean;
  quoted: boolean;
  quotedStart: boolean;
}

function readTokenText(s: string, i: number): [string, number, boolean, boolean] {
  const start = i;
  let tok = "";
  let quoted = false;
  let inQuote = false;
  while (i < s.length && (inQuote || !/\s/.test(s[i]))) {
    if (s[i] === '"' && !isEscaped(s, i, start)) {
      quoted = true;
      inQuote = !inQuote;
      i++;
    } else if (inQuote && s[i] === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) {
      tok += s[i + 1];
      i += 2;
    } else {
      tok += s[i++];
    }
  }
  return [tok, i, quoted, s[start] === '"'];
}

function readToken(s: string, i: number): [RawTerm, number] {
  const neg = s[i] === "-" && i + 1 < s.length && !/\s/.test(s[i + 1]);
  const [text, next, quoted, quotedStart] = readTokenText(s, neg ? i + 1 : i);
  return [{ text, neg, quoted, quotedStart }, next];
}

function tokenize(s: string): RawTerm[] {
  const out: RawTerm[] = [];
  let i = 0;
  while (i < s.length) {
    i = skipSpaces(s, i);
    if (i >= s.length) break;
    const [term, next] = readToken(s, i);
    out.push(term);
    i = next;
  }
  return out;
}

/** Split a filter string into its raw whitespace-separated segments, preserving
 *  quotes (unlike `tokenize`). Used to render removable filter-term pills: drop a
 *  segment and `.join(" ")` reconstructs the exact remaining query. */
export function rawSegments(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let inQuote = false;
    while (i < s.length && (inQuote || !/\s/.test(s[i]))) {
      if (s[i] === '"' && !isEscaped(s, i, start)) inQuote = !inQuote;
      i++;
    }
    out.push(s.slice(start, i));
  }
  return out;
}

function isEscaped(value: string, index: number, start: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= start && value[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 !== 0;
}

interface ClassifiedTerm {
  summary?: SummaryTerm;
  content?: ContentTerm;
  /** Bare terms project onto the URL for summary-only consumers, but are not a
   * safe prefilter for traffic because their header/body branch may match. */
  candidateSafe: boolean;
}

function contentField(key: string): ContentTerm["field"] {
  if (HEADER_KEYS.has(key)) return "headers";
  if (COOKIE_KEYS.has(key)) return "cookies";
  if (CONTENT_KEYS.has(key)) return "content";
  if (BODY_KEYS.has(key)) return "body";
  return "all";
}

function contentSide(key: string): ContentTerm["side"] {
  if (key.startsWith("req-")) return "request";
  if (key.startsWith("resp-")) return "response";
  return "either";
}

function contentTermOf(key: string, value: string, neg: boolean, quoted: boolean): ContentTerm {
  const m = quoted ? null : /^\/(.*)\/$/.exec(value);
  return {
    field: contentField(key),
    side: contentSide(key),
    value: m ? m[1] : value,
    regex: !!m,
    neg,
  };
}

function regexTermOf(raw: string, neg: boolean, urlOnly = false): SummaryTerm | null {
  const rx = /^\/(.*)\/$/.exec(raw);
  if (!rx) return null;
  let re: RegExp | null = null;
  try {
    re = new RegExp(rx[1], "i");
  } catch {}
  return { t: urlOnly ? "url-regex" : "regex", re, neg };
}

function classifyTerm(
  raw: string,
  neg: boolean,
  quoted: boolean,
  quotedStart: boolean,
): ClassifiedTerm {
  const colon = raw.indexOf(":");
  if (!quotedStart && colon > 0) {
    const key = raw.slice(0, colon).toLowerCase();
    const value = raw.slice(colon + 1);
    if (
      BODY_KEYS.has(key) ||
      HEADER_KEYS.has(key) ||
      COOKIE_KEYS.has(key) ||
      CONTENT_KEYS.has(key)
    ) {
      return { content: contentTermOf(key, value, neg, quoted), candidateSafe: true };
    }
    if (key === "url") {
      return {
        summary: (!quoted && regexTermOf(value, neg, true)) || {
          t: "url-text",
          value: value.toLowerCase(),
          neg,
        },
        candidateSafe: true,
      };
    }
    if (SUMMARY_KEYS.has(key)) {
      return { summary: { t: "kv", key, value, neg }, candidateSafe: true };
    }
  }

  const summary = (!quoted && regexTermOf(raw, neg)) || {
    t: "text" as const,
    value: raw.toLowerCase(),
    neg,
  };
  return {
    summary,
    content: contentTermOf("all", raw, neg, quoted),
    candidateSafe: false,
  };
}

export function parseFilter(input: string): ParsedFilter {
  const summaryTerms: SummaryTerm[] = [];
  const candidateTerms: SummaryTerm[] = [];
  const contentTerms: ContentTerm[] = [];

  for (const { text, neg, quoted, quotedStart } of tokenize(input)) {
    if (!text) continue;
    const classified = classifyTerm(text, neg, quoted, quotedStart);
    if (classified.summary) {
      summaryTerms.push(classified.summary);
      if (classified.candidateSafe) candidateTerms.push(classified.summary);
    }
    if (classified.content && classified.content.value !== "") {
      contentTerms.push(classified.content);
    }
  }

  return {
    matchSummary: (s) => summaryTerms.every((term) => matchTerm(term, s)),
    matchCandidates: (s) => candidateTerms.every((term) => matchTerm(term, s)),
    contentTerms,
  };
}

function urlOf(s: FlowSummary): string {
  return `${s.method} ${s.scheme}://${s.host}${s.path}`;
}

function explicitUrlOf(s: FlowSummary): string {
  return `${s.scheme}://${s.host}${s.path}`;
}

function extOf(path: string): string {
  const p = path.split("?")[0];
  const dot = p.lastIndexOf(".");
  const slash = p.lastIndexOf("/");
  return dot > slash && dot !== -1 ? p.slice(dot + 1).toLowerCase() : "";
}

function parseSize(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/i.exec(v.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1);
}

const SIZE_KEYS = new Set(["larger-than", "smaller-than", "req-larger-than"]);

/** Whether a comparison/enum term has an unusable value (empty or junk). Such a
 *  term must match NOTHING — and, crucially, must not flip to matching EVERYTHING
 *  when negated (see matchTerm). */
function numericValueInvalid(key: string, value: string): boolean {
  if (key === "is") {
    const v = value.trim().toLowerCase();
    return v !== "imported" && v !== "captured" && v !== "live";
  }
  if (SIZE_KEYS.has(key)) return Number.isNaN(parseSize(value));
  if (key === "slower-than") {
    const t = value.trim();
    // Number("") === 0 (not NaN), so guard the empty string explicitly.
    return t === "" || !Number.isFinite(Number(t));
  }
  if (key === "status") {
    const v = value.trim().toLowerCase();
    return (
      v === "" ||
      (!/^[1-5]xx$/.test(v) && !/^(>=|<=|>|<)\d+$/.test(v) && !Number.isFinite(Number(v)))
    );
  }
  return false;
}

/** status:404 (exact), status:4xx (class), status:>=400 / <500 (ranges). */
function matchStatus(value: string, status: number | null): boolean {
  if (status == null) return false; // in-flight matches only the Pending chip
  const v = value.trim().toLowerCase();
  if (/^[1-5]xx$/.test(v)) return Math.floor(status / 100) === Number(v[0]);
  const r = /^(>=|<=|>|<)(\d+)$/.exec(v);
  if (r) {
    const n = Number(r[2]);
    return r[1] === ">="
      ? status >= n
      : r[1] === "<="
        ? status <= n
        : r[1] === ">"
          ? status > n
          : status < n;
  }
  const exact = Number(v);
  return Number.isFinite(exact) && status === exact;
}

function matchKv(key: string, value: string, s: FlowSummary): boolean {
  const v = value.toLowerCase();
  switch (key) {
    case "method":
      return s.method.toLowerCase() === v;
    case "host":
    case "domain":
      return s.host.toLowerCase().includes(v);
    case "path":
      return s.path.toLowerCase().includes(v);
    case "scheme":
      return s.scheme.toLowerCase() === v;
    case "status":
      return matchStatus(value, s.status);
    case "mime":
      return (s.mime ?? "").toLowerCase().includes(v);
    case "kind":
      return s.kind === (v === "fetch" ? "xhr" : v);
    case "ext":
      return extOf(s.path) === v;
    case "is":
      // is:imported (loaded from a file) vs is:captured / is:live (live proxy).
      // An unknown value matches nothing (it must not flip to all when negated).
      if (v === "imported") return s.imported;
      if (v === "captured" || v === "live") return !s.imported;
      return false;
    case "rule":
    case "matched":
      return value ? (s.matchedRule ?? "").toLowerCase().includes(v) : s.matchedRule != null;
    case "larger-than":
      return s.respSize > parseSize(value);
    case "smaller-than":
      return s.respSize < parseSize(value);
    case "req-larger-than":
      return s.reqSize > parseSize(value);
    case "slower-than":
      return s.durationMs != null && s.durationMs > Number(value);
    default:
      return true;
  }
}

// Cap the input a user-supplied /regex/ runs against. URLs are short, so this
// bounds per-match work and polynomial backtracking without affecting real
// matches. (A pathological exponential pattern on the local user's own filter
// is still a footgun, but it's their own input — out of scope per the threat
// model; this just keeps accidental slow patterns from scaling with body/URL size.)
const MAX_REGEX_INPUT = 2048;

function matchTerm(term: SummaryTerm, s: FlowSummary): boolean {
  let r: boolean;
  if (term.t === "text") r = urlOf(s).toLowerCase().includes(term.value);
  else if (term.t === "regex") r = term.re?.test(urlOf(s).slice(0, MAX_REGEX_INPUT)) ?? false;
  else if (term.t === "url-text") r = explicitUrlOf(s).toLowerCase().includes(term.value);
  else if (term.t === "url-regex") {
    r = term.re?.test(explicitUrlOf(s).slice(0, MAX_REGEX_INPUT)) ?? false;
  } else {
    // A malformed numeric value (empty while typing, or junk like "10gb")
    // matches nothing regardless of negation — otherwise `-larger-than:bogus`
    // or `slower-than:` would highlight every flow.
    if (numericValueInvalid(term.key, term.value)) return false;
    r = matchKv(term.key, term.value, s);
  }
  return term.neg ? !r : r;
}

/** Whether a flow passes the full frontend-evaluable filter: the kind/status
 *  chip sets (empty set = no constraint) plus the parsed summary terms. */
export function matchesFilter(
  s: FlowSummary,
  parsed: ParsedFilter,
  typeChips: Set<ResourceKind>,
  statusChips: Set<string>,
): boolean {
  if (typeChips.size && !typeChips.has(s.kind)) return false;
  if (statusChips.size && !statusChips.has(statusClass(s.status))) return false;
  return parsed.matchSummary(s);
}

/** Candidate seed for a backend scan. Bare/all terms are intentionally absent:
 * a URL miss cannot rule out a hit in headers or a decoded body. */
export function collectCandidates(
  flows: FlowSummary[],
  parsed: ParsedFilter,
  typeChips: Set<ResourceKind>,
  statusChips: Set<string>,
): Set<string> {
  const set = new Set<string>();
  for (const s of flows) {
    if (typeChips.size && !typeChips.has(s.kind)) continue;
    if (statusChips.size && !statusChips.has(statusClass(s.status))) continue;
    if (parsed.matchCandidates(s)) set.add(s.id);
  }
  return set;
}

// ---- chips ----

export const KIND_CHIPS: { kind: ResourceKind; label: string }[] = [
  { kind: "xhr", label: "Fetch/XHR" },
  { kind: "doc", label: "Doc" },
  { kind: "js", label: "JS" },
  { kind: "css", label: "CSS" },
  { kind: "img", label: "Img" },
  { kind: "font", label: "Font" },
  { kind: "media", label: "Media" },
  { kind: "ws", label: "WS" },
  { kind: "wasm", label: "Wasm" },
  { kind: "other", label: "Other" },
];

export const STATUS_CHIPS = ["2xx", "3xx", "4xx", "5xx", "pending"] as const;

export function statusClass(status: number | null): string {
  return status == null ? "pending" : `${Math.floor(status / 100)}xx`;
}

/** Tone class (`s2`…`s5` / `pending`) coloring a status code in dense lists. */
export function statusCls(status: number | null): string {
  if (status === null) return "pending";
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 300) return "s3";
  return "s2";
}
