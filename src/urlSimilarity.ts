import { isEqual } from "es-toolkit";

import { lcsLength } from "./diff";

// URL similarity for the compare view's match indicator (issue #86): smarter
// than character overlap — URLs are compared structurally (host labels, path
// segments, query parameters) so a request that only differs in a random
// id/timestamp query value still scores as a near match.

const WEIGHT_SCHEME = 0.05;
const WEIGHT_HOST = 0.25;
const WEIGHT_PATH = 0.5;
const WEIGHT_QUERY = 0.2;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Host-label overlap anchored at the registrable end: `api.foo.com` vs
 *  `www.foo.com` share `com`,`foo` → 2/3; a different domain stops at the
 *  first mismatched label instead of crediting a shared subdomain name. */
function hostSimilarity(a: URL, b: URL): number {
  if (a.host === b.host) return 1;
  const la = a.hostname.split(".").reverse();
  const lb = b.hostname.split(".").reverse();
  let matches = 0;
  while (matches < Math.min(la.length, lb.length) && la[matches] === lb[matches]) matches++;
  const labels = matches / Math.max(la.length, lb.length);
  return a.port === b.port ? labels : labels / 2;
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter((s) => s !== "");
}

function pathSimilarity(a: URL, b: URL): number {
  const sa = segments(a.pathname);
  const sb = segments(b.pathname);
  if (sa.length === 0 && sb.length === 0) return 1;
  return lcsLength(sa, sb) / Math.max(sa.length, sb.length);
}

function params(u: URL): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [k, v] of u.searchParams) {
    const values = map.get(k);
    if (values) values.push(v);
    else map.set(k, [v]);
  }
  return map;
}

/** Query overlap over the union of parameter names: a name present on both
 *  sides scores 1 with equal values, 0.5 with different values (same knob,
 *  different setting), and 0 when only one side has it. */
function querySimilarity(a: Map<string, string[]>, b: Map<string, string[]>): number {
  const names = new Set([...a.keys(), ...b.keys()]);
  let score = 0;
  for (const name of names) {
    const va = a.get(name);
    const vb = b.get(name);
    if (va && vb) score += isEqual(va, vb) ? 1 : 0.5;
  }
  return score / names.size;
}

/**
 * Structural similarity of two absolute URLs as a percentage. 100 only for
 * byte-identical strings; anything else caps at 99 so a "perfect" badge never
 * lies. Unparseable URLs match only themselves.
 */
export function urlSimilarity(a: string, b: string): number {
  if (a === b) return 100;
  const ua = parse(a);
  const ub = parse(b);
  if (!ua || !ub) return 0;
  const qa = params(ua);
  const qb = params(ub);
  const hasQuery = qa.size > 0 || qb.size > 0;
  const scheme = ua.protocol === ub.protocol ? 1 : 0;
  const score =
    WEIGHT_SCHEME * scheme +
    WEIGHT_HOST * hostSimilarity(ua, ub) +
    WEIGHT_PATH * pathSimilarity(ua, ub) +
    (hasQuery ? WEIGHT_QUERY * querySimilarity(qa, qb) : 0);
  const denom = WEIGHT_SCHEME + WEIGHT_HOST + WEIGHT_PATH + (hasQuery ? WEIGHT_QUERY : 0);
  return Math.min(Math.round((score / denom) * 100), 99);
}
