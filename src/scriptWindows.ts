import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { flushDetachedWindows, onWindowFlushRequested } from "./windowFlush";
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
const SCRIPTS_WINDOW_CLOSED = "germi://scripts-window-closed";
const SCRIPTS_FLUSH_REQUESTED = "germi://scripts-flush-requested";
const SCRIPTS_FLUSH_FINISHED = "germi://scripts-flush-finished";
const SCRIPTS_WINDOW_LABEL = "scripts";

const DEFAULT_SIZE = { width: 780, height: 720 };
const MIN_SIZE = { width: 480, height: 400 };

export function currentScriptsWindowLabel(): string {
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

export async function isScriptsWindowOpen(): Promise<boolean> {
  return (await WebviewWindow.getByLabel(SCRIPTS_WINDOW_LABEL)) !== null;
}

export function onScriptsWindowClosed(handler: () => void): Promise<UnlistenFn> {
  return listen(SCRIPTS_WINDOW_CLOSED, () => handler());
}

/** Answer a main-window shutdown request only after this window's latest edit
 * has reached disk. A rejection keeps both windows alive. */
export function onScriptsFlushRequested(
  handler: (closeAfterFlush: boolean) => Promise<void>,
): Promise<UnlistenFn> {
  return onWindowFlushRequested({
    requestEvent: SCRIPTS_FLUSH_REQUESTED,
    resultEvent: SCRIPTS_FLUSH_FINISHED,
    targetId: SCRIPTS_WINDOW_LABEL,
    flush: handler,
  });
}

/** Ask the detached editor to save before the main window quits. The destroyed
 * event is also success: that window's own close handler flushes before destroy.
 */
export async function flushDetachedScriptsWindow(
  timeoutMs = 5_000,
  closeAfterFlush = false,
): Promise<void> {
  await flushDetachedWindows({
    requestEvent: SCRIPTS_FLUSH_REQUESTED,
    resultEvent: SCRIPTS_FLUSH_FINISHED,
    closeAfterFlush,
    timeoutMs,
    listOpenTargetIds: async () => ((await isScriptsWindowOpen()) ? [SCRIPTS_WINDOW_LABEL] : []),
    onTargetClosed: (handler) => onScriptsWindowClosed(() => handler(SCRIPTS_WINDOW_LABEL)),
    saveError: () => "The detached scripts editor could not save.",
    timeoutError: () => "Timed out waiting for the detached scripts editor to save.",
  });
}
