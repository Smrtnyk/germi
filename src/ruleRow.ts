import type { ActionSummary, Matcher, RuleSummary } from "./types";

/**
 * Presentation parts for a compact rule row (issue #72). The rule list used to
 * print the URL twice — once as a name line, once inside a "METHOD · url → action"
 * summary. Rules no longer carry a name (issue #74); this splits a rule's single
 * matcher pattern into host / path (mirroring the traffic list) plus a compact
 * action label.
 */
export interface RuleRowParts {
  /** Uppercased method, or "ANY" when the matcher matches every method. */
  method: string;
  /** Method color class (`m-get` …) matching styles.css, or null for ANY/other. */
  methodClass: string | null;
  /** Authority part of the pattern (may be empty for bare paths / regex). */
  host: string;
  /** Path (or the raw pattern when it isn't URL-shaped). */
  path: string;
  /** Compact action label (e.g. "200 application/json", "block 403"). */
  action: string;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const COLORED_METHODS = ["get", "post", "put", "patch", "delete"];

/** A pre-slash token looks like an authority if it carries a dot or a port. */
function looksLikeHost(s: string): boolean {
  return /[.:]/.test(s) && !/\s/.test(s);
}

/**
 * Split a matcher pattern into host + path. A stored scheme (from an auto-mock,
 * `respond_rule_from_flow`) means the leading token is definitely the authority;
 * otherwise fall back to a dot/port heuristic. Regex patterns and substrings that
 * don't look URL-shaped are shown verbatim as the path.
 */
export function splitPattern(matcher: Matcher): { host: string; path: string } {
  const raw = matcher.url.trim();
  if (raw === "") return { host: "", path: "" };
  if (matcher.urlMatch === "regex") return { host: "", path: raw };

  const hadScheme = SCHEME_RE.test(raw);
  const noScheme = raw.replace(SCHEME_RE, "");
  const slash = noScheme.indexOf("/");
  if (slash === -1) {
    // A bare token with no path: only a stored scheme proves it's really a host.
    // Guessing (e.g. treating the substring "app.min.js" as a host) would render
    // a misleading "app.min.js/", so show ambiguous substrings verbatim instead.
    return hadScheme ? { host: noScheme, path: "" } : { host: "", path: noScheme };
  }
  const head = noScheme.slice(0, slash);
  const rest = noScheme.slice(slash);
  if (head === "") return { host: "", path: rest };
  if (hadScheme || looksLikeHost(head)) return { host: head, path: rest };
  return { host: "", path: noScheme };
}

export function methodColorClass(method: string | null): string | null {
  if (!method) return null;
  const m = method.toLowerCase();
  return COLORED_METHODS.includes(m) ? `m-${m}` : null;
}

/** Compact one-line action label, mirroring the old inline `actionSummary`. */
export function actionLabel(a: ActionSummary): string {
  switch (a.kind) {
    case "respond":
      return `${a.status}${a.contentType ? " " + a.contentType.split(";")[0] : ""}${
        a.contentEncoding ? ` · ${a.contentEncoding}` : ""
      }`;
    case "mapLocal":
      return `file → ${a.status}`;
    case "block":
      return "block 403";
    case "setStatus":
      return `status ${a.status}`;
    case "setResponseHeader":
      return `resp ${a.name || "header"}`;
    case "setRequestHeader":
      return `req ${a.name || "header"}`;
    case "rewriteResponseBody":
      return "rewrite body";
  }
}

export function ruleRowParts(rule: RuleSummary): RuleRowParts {
  const { host, path } = splitPattern(rule.matcher);
  return {
    method: rule.matcher.method || "ANY",
    methodClass: methodColorClass(rule.matcher.method),
    host,
    path,
    action: actionLabel(rule.action),
  };
}
