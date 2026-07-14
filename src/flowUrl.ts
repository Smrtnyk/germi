import type { FlowDetail, FlowSummary } from "./types";

/**
 * Reconstruct a flow's absolute URL from its summary parts. `path` already
 * carries any query string, so this round-trips what the Inspector and the
 * "Copy as cURL" command show — shared by the row context menu and the
 * Ctrl/⌘ U "copy URL" shortcut.
 */
export function flowUrl(f: Pick<FlowSummary, "scheme" | "host" | "path">): string {
  return `${f.scheme}://${f.host}${f.path}`;
}

/** Prefer the captured absolute request target when available. Older/imported
 * details may carry only an origin-form URI, so retain the parts fallback. */
export function flowDetailUrl(
  detail: Pick<FlowDetail, "uri" | "scheme" | "host" | "path">,
): string {
  const uri = detail.uri.trim();
  return /^https?:\/\//i.test(uri) ? uri : flowUrl(detail);
}
