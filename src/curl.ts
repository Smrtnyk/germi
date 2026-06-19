import type { FlowDetail } from "./types";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SKIP_HEADERS = new Set(["content-length", "host", "connection", "proxy-connection"]);

/** Reconstruct an approximate `curl` invocation for a captured request. */
export function toCurl(detail: FlowDetail): string {
  const url = `${detail.scheme}://${detail.host}${detail.path}`;
  const parts = [`curl ${shellQuote(url)}`];
  const method = detail.method.toUpperCase();
  if (method !== "GET") parts.push(`-X ${method}`);
  for (const [k, v] of detail.request.headers) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  const body = detail.request.bodyText;
  if (body && detail.request.size > 0) parts.push(`--data-raw ${shellQuote(body)}`);
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
