import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { openOrFocusWindow } from "./windows";

/**
 * The compare window (issue #86) — a real, non-modal OS window (label
 * `compare`, singleton) so the traffic list stays visible and capturing while
 * you compare. The seed travels through the backend mailbox
 * (`set_compare_seed` / `get_compare_seed`, flow ids only); this module only
 * opens/focuses the window and broadcasts re-seeds:
 *
 *  - `COMPARE_SEED_CHANGED` — the main window stored a fresh seed while the
 *    compare window was already open; it re-reads the mailbox and resets.
 */
const COMPARE_SEED_CHANGED = "germi://compare-seed-changed";

const LABEL = "compare";
const DEFAULT_SIZE = { width: 1150, height: 780 };
const MIN_SIZE = { width: 760, height: 520 };

/** Open the compare window, or focus + re-seed it if it is already open. */
export async function openOrFocusCompareWindow(): Promise<void> {
  const result = await openOrFocusWindow(LABEL, {
    url: "index.html?compare=1",
    title: "Compare requests",
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
  });
  if (result === "focused") await emit(COMPARE_SEED_CHANGED, null);
}

export function onCompareSeedChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(COMPARE_SEED_CHANGED, () => handler());
}
