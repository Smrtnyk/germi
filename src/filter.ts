import type { FlowSummary, ResourceKind } from "./types";

// ---- the token filter ----
//
// Grammar (DevTools-flavored): whitespace-separated terms = AND. A bare word (or
// "quoted phrase") is a case-insensitive substring over `method scheme://host
// path`. A `/regex/` term is a regex over that same string. A leading `-`
// negates any term. `key:value` tokens filter structured fields. `body:` /
// `req-body:` / `resp-body:` and `header:` / `req-header:` / `resp-header:` are
// the only tokens that cross into the backend.

export interface ContentTerm {
  field: "body" | "headers";
  side: "request" | "response" | "either";
  value: string;
  regex: boolean;
  neg: boolean;
}

type SummaryTerm =
  | { t: "text"; value: string; neg: boolean }
  | { t: "regex"; re: RegExp; neg: boolean }
  | { t: "kv"; key: string; value: string; neg: boolean };

export interface ParsedFilter {
  /** Predicate over a FlowSummary for all non-content terms (instant, frontend). */
  matchSummary: (s: FlowSummary) => boolean;
  /** Content terms requiring a backend scan. Empty = no backend call needed. */
  contentTerms: ContentTerm[];
}

const SUMMARY_KEYS = new Set([
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

function skipSpaces(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function findClosingQuote(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === '"') return j;
  }
  return -1;
}

function readToken(s: string, i: number): [string, number] {
  let tok = "";
  while (i < s.length && !/\s/.test(s[i])) {
    const phraseStart = tok === "" || tok.endsWith(":");
    if (s[i] === '"' && phraseStart) {
      const close = findClosingQuote(s, i);
      if (close === -1) {
        tok += s[i++];
        continue;
      }
      tok += s.slice(i + 1, close);
      i = close + 1;
    } else {
      tok += s[i++];
    }
  }
  return [tok, i];
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    i = skipSpaces(s, i);
    if (i >= s.length) break;
    const [tok, next] = readToken(s, i);
    out.push(tok);
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
      if (s[i] === '"') inQuote = !inQuote;
      i++;
    }
    out.push(s.slice(start, i));
  }
  return out;
}

type ClassifiedTerm =
  | { kind: "summary"; term: SummaryTerm }
  | { kind: "content"; term: ContentTerm };

function contentTermOf(key: string, value: string, neg: boolean): ContentTerm {
  const field = HEADER_KEYS.has(key) ? "headers" : "body";
  const side =
    key === "req-body" || key === "req-header"
      ? "request"
      : key === "resp-body" || key === "resp-header"
        ? "response"
        : "either";
  const m = /^\/(.*)\/$/.exec(value);
  return { field, side, value: m ? m[1] : value, regex: !!m, neg };
}

function regexTermOf(raw: string, neg: boolean): SummaryTerm | null {
  const rx = /^\/(.*)\/$/.exec(raw);
  if (!rx) return null;
  try {
    return { t: "regex", re: new RegExp(rx[1], "i"), neg };
  } catch {
    return null;
  }
}

function classifyTerm(raw: string): ClassifiedTerm {
  let neg = false;
  if (raw.startsWith("-") && raw.length > 1) {
    neg = true;
    raw = raw.slice(1);
  }

  const colon = raw.indexOf(":");
  if (colon > 0) {
    const key = raw.slice(0, colon).toLowerCase();
    const value = raw.slice(colon + 1);
    if (BODY_KEYS.has(key) || HEADER_KEYS.has(key)) {
      return { kind: "content", term: contentTermOf(key, value, neg) };
    }
    if (SUMMARY_KEYS.has(key)) return { kind: "summary", term: { t: "kv", key, value, neg } };
  }

  const regex = regexTermOf(raw, neg);
  if (regex) return { kind: "summary", term: regex };
  return { kind: "summary", term: { t: "text", value: raw.toLowerCase(), neg } };
}

export function parseFilter(input: string): ParsedFilter {
  const summaryTerms: SummaryTerm[] = [];
  const contentTerms: ContentTerm[] = [];

  for (const raw of tokenize(input)) {
    if (!raw) continue;
    const classified = classifyTerm(raw);
    if (classified.kind === "content") {
      if (classified.term.value !== "") contentTerms.push(classified.term);
    } else summaryTerms.push(classified.term);
  }

  return {
    matchSummary: (s) => summaryTerms.every((term) => matchTerm(term, s)),
    contentTerms,
  };
}

function urlOf(s: FlowSummary): string {
  return `${s.method} ${s.scheme}://${s.host}${s.path}`;
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
  else if (term.t === "regex") r = term.re.test(urlOf(s).slice(0, MAX_REGEX_INPUT));
  else {
    // A malformed numeric value (empty while typing, or junk like "10gb")
    // matches nothing regardless of negation — otherwise `-larger-than:bogus`
    // or `slower-than:` would highlight every flow.
    if (numericValueInvalid(term.key, term.value)) return false;
    r = matchKv(term.key, term.value, s);
  }
  return term.neg ? !r : r;
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
