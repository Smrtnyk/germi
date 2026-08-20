import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { onFilterWindowReady } from "./filterWindowEvents";
import { openOrFocusWindow } from "./windows";

export const FILTER_WINDOW_LABEL = "filter-builder";
export const FILTER_WINDOW_SESSION_PARAM = "filterSession";
export const FILTER_WINDOW_OPTIONS = {
  url: "index.html?filter=1",
  title: "Create saved filter",
  width: 720,
  height: 760,
  minWidth: 520,
  minHeight: 580,
  resizable: true,
  decorations: true,
} as const;

export const FILTER_WINDOW_READY_TIMEOUT_MS = 10_000;
const FILTER_WINDOW_DESTROY_TIMEOUT_MS = 1_000;
const FILTER_WINDOW_REMOVAL_POLL_MS = 25;

class FilterWindowOpenCancelled extends Error {
  constructor() {
    super("The filter-window open was cancelled.");
    this.name = "FilterWindowOpenCancelled";
  }
}

function filterWindowCleanupError(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { name: "FilterWindowCleanupError", cause });
}

interface FilterWindowOpenAttempt {
  promise: Promise<"focused" | "created">;
  cancel: () => void;
}

let opening: FilterWindowOpenAttempt | null = null;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getFilterWindowBefore(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("timed out confirming filter-window manager removal");
  return Promise.race([
    WebviewWindow.getByLabel(FILTER_WINDOW_LABEL),
    delay(remaining).then(() => {
      throw new Error("timed out inspecting filter-window manager state");
    }),
  ]);
}

async function destroyUnreadyFilterWindow(): Promise<void> {
  const deadline = Date.now() + FILTER_WINDOW_DESTROY_TIMEOUT_MS;
  const window = await getFilterWindowBefore(deadline);
  if (!window) return;

  let destroyed = false;
  let announceDestroyed!: () => void;
  const destroyedSignal = new Promise<void>((resolve) => {
    announceDestroyed = resolve;
  });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await window.once("tauri://destroyed", () => {
      destroyed = true;
      announceDestroyed();
    });
  } catch {
    // If event subscription itself fails, the manager lookup below remains an
    // authoritative fallback; never guess that a queued destroy has finished.
  }

  try {
    await window.destroy();
  } catch (error) {
    if (await getFilterWindowBefore(deadline)) throw error;
    return;
  }

  try {
    for (;;) {
      if (destroyed) return;
      if (!(await getFilterWindowBefore(deadline))) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out confirming filter-window manager removal");
      }
      await Promise.race([
        destroyedSignal,
        delay(Math.min(FILTER_WINDOW_REMOVAL_POLL_MS, remaining)),
      ]);
    }
  } finally {
    unlisten?.();
  }
}

function beginFilterWindowOpen(sessionId: string): FilterWindowOpenAttempt {
  let cancelled = false;
  let cancel!: () => void;
  const cancelledSignal = new Promise<"cancelled">((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve("cancelled");
    };
  });

  const promise = (async (): Promise<"focused" | "created"> => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const unlisten = await onFilterWindowReady((lifecycle) => {
      if (lifecycle.sessionId === sessionId) resolveReady();
    });
    let requiresCleanup = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      if (cancelled) throw new FilterWindowOpenCancelled();
      const timedOut = new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), FILTER_WINDOW_READY_TIMEOUT_MS);
      });
      const disposition = await Promise.race([
        openOrFocusWindow(
          FILTER_WINDOW_LABEL,
          {
            ...FILTER_WINDOW_OPTIONS,
            url: `${FILTER_WINDOW_OPTIONS.url}&${FILTER_WINDOW_SESSION_PARAM}=${encodeURIComponent(sessionId)}`,
          },
          controller.signal,
        ),
        cancelledSignal,
        timedOut,
      ]);
      if (disposition === "cancelled") {
        requiresCleanup = true;
        controller.abort();
        throw new FilterWindowOpenCancelled();
      }
      if (disposition === "timed-out") {
        requiresCleanup = true;
        controller.abort();
        throw new Error("the native filter window did not become ready");
      }
      if (disposition === "focused") return disposition;
      requiresCleanup = true;

      const outcome = await Promise.race([
        ready.then(() => "ready" as const),
        cancelledSignal,
        timedOut,
      ]);
      if (outcome === "ready") {
        requiresCleanup = false;
        return disposition;
      }
      if (outcome === "cancelled") throw new FilterWindowOpenCancelled();
      throw new Error("the native filter window did not become ready");
    } catch (error) {
      if (requiresCleanup) {
        try {
          await destroyUnreadyFilterWindow();
        } catch (cleanupError) {
          throw filterWindowCleanupError(
            `${String(error)}; cleanup failed: ${String(cleanupError)}`,
            cleanupError,
          );
        }
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      unlisten();
    }
  })();

  return { promise, cancel };
}

/** Open a singleton, ordinary top-level OS window. It intentionally has no
 * `parent` option: the main window remains enabled and the filter builder can
 * be moved independently across the desktop. */
export function openOrFocusFilterWindow(): Promise<"focused" | "created"> {
  if (opening) return opening.promise;
  const sessionId = crypto.randomUUID();
  const attempt = beginFilterWindowOpen(sessionId);
  opening = attempt;
  void attempt.promise.then(
    () => {
      if (opening === attempt) opening = null;
    },
    () => {
      if (opening === attempt) opening = null;
    },
  );
  return attempt.promise;
}

export async function cancelPendingFilterWindowOpen(): Promise<void> {
  const attempt = opening;
  if (!attempt) return;
  attempt.cancel();
  try {
    await attempt.promise;
  } catch (error) {
    if (!(error instanceof FilterWindowOpenCancelled)) throw error;
  }
}

export function isFilterWindowOpenCancelled(error: unknown): boolean {
  return error instanceof FilterWindowOpenCancelled;
}

export async function closeFilterWindow(): Promise<void> {
  const current = getCurrentWindow();
  await WebviewWindow.getByLabel("main")
    .then((main) => main?.setFocus())
    .catch(() => {});
  await current.destroy();
}

export function filterWindowSessionId(search = window.location.search): string {
  return new URLSearchParams(search).get(FILTER_WINDOW_SESSION_PARAM) ?? "";
}
