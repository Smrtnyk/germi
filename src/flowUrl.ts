import type { FlowSummary } from "./types";

/**
 * Reconstruct a flow's absolute URL from its summary parts. `path` already
 * carries any query string, so this round-trips what the Inspector and the
 * "Copy as cURL" command show — shared by the row context menu and the
 * Ctrl/⌘ U "copy URL" shortcut.
 */
export function flowUrl(f: Pick<FlowSummary, "scheme" | "host" | "path">): string {
  return `${f.scheme}://${f.host}${f.path}`;
}
