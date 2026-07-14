import type { FlowDetail } from "./types";
import { flowDetailUrl } from "./flowUrl";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SKIP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Reconstruct a byte-faithful POSIX-shell `curl` invocation. */
export function toCurl(detail: FlowDetail): string {
  const url = flowDetailUrl(detail);
  const parts = [`curl ${shellQuote(url)}`];
  // HTTP methods are case-sensitive. Preserve a captured extension method
  // exactly; only the canonical uppercase GET/HEAD forms get curl shortcuts.
  const method = detail.method;
  const hasBody = detail.request.size > 0;
  if (method === "HEAD" && !hasBody) {
    // `-X HEAD` only changes the method string: curl still waits for a response
    // body promised by Content-Length. `--head` also enables HEAD semantics.
    parts.push("--head");
  } else if (method !== "GET" || hasBody) {
    // HTTP methods are tokens, not shell identifiers (`'`, `$` and backticks
    // are legal token characters). Quote captured input just like URL/headers.
    parts.push(`-X ${shellQuote(method)}`);
  }
  const connectionHeaders = new Set(
    detail.request.headers
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(","))
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [k, v] of detail.request.headers) {
    const lower = k.toLowerCase();
    if (SKIP_HEADERS.has(lower) || connectionHeaders.has(lower)) continue;
    // A decoded inspector detail carries identity body bytes. Keeping the
    // original Content-Encoding beside those bytes would make the replay lie.
    if (lower === "content-encoding" && detail.request.decoded) continue;
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (hasBody && detail.request.bodyBase64) {
    parts.push("--data-binary @-");
    return `printf %s ${shellQuote(detail.request.bodyBase64)} | base64 --decode | ${parts.join(
      " \\\n  ",
    )}`;
  }
  if (hasBody) parts.push(`--data-binary ${shellQuote(detail.request.bodyText)}`);
  return parts.join(" \\\n  ");
}

export function headersToText(headers: [string, string][]): string {
  return headers.map(([k, v]) => `${k}: ${v}`).join("\n");
}

export interface KV {
  key: string;
  value: string;
}

/** Parse the `?a=b&c=d` portion of a path into decoded key/value pairs. */
export function parseQuery(path: string): KV[] {
  const q = path.indexOf("?");
  if (q === -1) return [];
  const search = path.slice(q + 1);
  if (!search) return [];
  const out: KV[] = [];
  for (const pair of search.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawK = eq === -1 ? pair : pair.slice(0, eq);
    const rawV = eq === -1 ? "" : pair.slice(eq + 1);
    out.push({ key: safeDecode(rawK), value: safeDecode(rawV) });
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function requestCookies(headers: [string, string][]): KV[] {
  const cookie = headers.find(([k]) => k.toLowerCase() === "cookie")?.[1];
  if (!cookie) return [];
  const out: KV[] = [];
  for (const pair of cookie.split(";")) {
    const t = pair.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    out.push({ key: eq === -1 ? t : t.slice(0, eq), value: eq === -1 ? "" : t.slice(eq + 1) });
  }
  return out;
}

function responseCookies(headers: [string, string][]): KV[] {
  const out: KV[] = [];
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== "set-cookie") continue;
    const first = v.split(";")[0];
    const eq = first.indexOf("=");
    out.push({
      key: eq === -1 ? first : first.slice(0, eq),
      value: eq === -1 ? "" : first.slice(eq + 1),
    });
  }
  return out;
}

/** Cookies for a side: request `Cookie` pairs, or response `Set-Cookie` names. */
export function parseCookies(headers: [string, string][], side: "request" | "response"): KV[] {
  return side === "request" ? requestCookies(headers) : responseCookies(headers);
}
