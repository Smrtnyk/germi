import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { openOrFocusWindow } from "./windows";

/**
 * The detached scripts editor window. The docked Scripts tab is narrow for code,
 * so "Open window" pops the same editor into a real, resizable OS window
 * (label `scripts`, single instance). Both windows edit the same `scripts.json`
 * via IPC and stay in sync through one broadcast: whoever saves emits
 * `SCRIPTS_CHANGED` (tagged with its window label) and the other reloads,
 * skipping the event it sent itself.
 */
const SCRIPTS_CHANGED = "germi://scripts-changed";
const SCRIPTS_WINDOW_LABEL = "scripts";

const DEFAULT_SIZE = { width: 780, height: 720 };
const MIN_SIZE = { width: 480, height: 400 };

export function currentWindowLabel(): string {
  return getCurrentWindow().label;
}

/** Open the detached scripts editor, or focus it if it is already open. */
export async function openOrFocusScriptsWindow(): Promise<void> {
  await openOrFocusWindow(SCRIPTS_WINDOW_LABEL, {
    url: "index.html?scripts=1",
    title: "Scripts",
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
  });
}

export interface ScriptsChangedPayload {
  /** Window label that saved, so listeners can ignore their own broadcast. */
  source: string;
}

/** Broadcast that scripts were saved from `source`; other windows reload. */
export function emitScriptsChanged(source: string): void {
  void emit(SCRIPTS_CHANGED, { source } satisfies ScriptsChangedPayload);
}

export function onScriptsChanged(handler: (p: ScriptsChangedPayload) => void): Promise<UnlistenFn> {
  return listen<ScriptsChangedPayload>(SCRIPTS_CHANGED, (e) => handler(e.payload));
}
