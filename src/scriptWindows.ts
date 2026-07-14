import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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

interface ScriptsFlushRequestPayload {
  requestId: string;
  closeAfterFlush?: boolean;
}

interface ScriptsFlushResultPayload {
  requestId: string;
  ok: boolean;
  error?: string;
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
  return listen<ScriptsFlushRequestPayload>(SCRIPTS_FLUSH_REQUESTED, (event) => {
    void Promise.resolve()
      .then(() => handler(event.payload.closeAfterFlush === true))
      .then(
        () =>
          emit(SCRIPTS_FLUSH_FINISHED, {
            requestId: event.payload.requestId,
            ok: true,
          } satisfies ScriptsFlushResultPayload),
        (error: unknown) =>
          emit(SCRIPTS_FLUSH_FINISHED, {
            requestId: event.payload.requestId,
            ok: false,
            error: String(error),
          } satisfies ScriptsFlushResultPayload),
      )
      // A shutdown handler destroys its own webview before this acknowledgement
      // can be emitted. The main window also listens for the shell-owned
      // destroyed event, so that expected emit failure is safe to ignore.
      .catch(() => {});
  });
}

function flushRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/** Ask the detached editor to save before the main window quits. The destroyed
 * event is also success: that window's own close handler flushes before destroy.
 */
export async function flushDetachedScriptsWindow(
  timeoutMs = 5_000,
  closeAfterFlush = false,
): Promise<void> {
  if (!(await isScriptsWindowOpen())) return;

  const requestId = flushRequestId();
  let settle!: (error?: Error) => void;
  // Resolve with an error and throw it only after the listeners and request
  // emission are fully installed. A fast failure acknowledgement must not
  // create a temporarily-unhandled rejected promise before we reach the await.
  const result = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    settle(error);
  };

  let unlistenResult: UnlistenFn | undefined;
  let unlistenClosed: UnlistenFn | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    unlistenResult = await listen<ScriptsFlushResultPayload>(SCRIPTS_FLUSH_FINISHED, (event) => {
      if (event.payload.requestId !== requestId) return;
      finish(
        event.payload.ok
          ? undefined
          : new Error(event.payload.error || "The detached scripts editor could not save."),
      );
    });
    unlistenClosed = await onScriptsWindowClosed(() => finish());

    // It may have closed while the asynchronous listeners were being installed.
    if (!(await isScriptsWindowOpen())) return;
    timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the detached scripts editor to save.")),
      timeoutMs,
    );
    await emit(SCRIPTS_FLUSH_REQUESTED, {
      requestId,
      closeAfterFlush,
    } satisfies ScriptsFlushRequestPayload);
    const error = await result;
    if (error) throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unlistenResult?.();
    unlistenClosed?.();
  }
}
