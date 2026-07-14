import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { openOrFocusWindow } from "./windows";

/**
 * Detached rule-editor windows (issue #72). Double-clicking a rule opens its
 * details in a real, non-modal OS window (`rule-<id>`), and several different
 * rules can be open at once. Because each window is its own webview with its own
 * React tree, edits are coordinated through two broadcast events rather than
 * shared state:
 *
 *  - `RULES_CHANGED` — a rule was saved / deleted / (un)done somewhere. Every
 *    window refreshes from the backend, skipping the event it emitted itself
 *    (via `source`) so it doesn't clobber in-progress typing.
 *  - `RULE_WINDOW_CLOSED` — a detail window is closing, so the main window drops
 *    it from its "open" set and unlocks the inline editor for that rule.
 *  - `RULE_WINDOW_RESIZED` — a detail window was resized; the main window persists
 *    its size so subsequent windows open at that remembered size.
 *  - `RULE_WINDOWS_FLUSH_REQUESTED` / `RULE_WINDOW_FLUSH_FINISHED` — the main
 *    window's shutdown barrier; every detached editor acknowledges only after
 *    its latest rule snapshot reaches durable storage.
 */
const RULES_CHANGED = "germi://rules-changed";
const RULE_WINDOW_CLOSED = "germi://rule-window-closed";
const RULE_WINDOW_RESIZED = "germi://rule-window-resized";
const RULE_WINDOWS_FLUSH_REQUESTED = "germi://rule-windows-flush-requested";
const RULE_WINDOW_FLUSH_FINISHED = "germi://rule-window-flush-finished";

const SIZE_KEY = "germi.ruleWindowSize";
const DEFAULT_SIZE = { width: 560, height: 720 };
const MIN_SIZE = { width: 420, height: 360 };

export interface RuleWindowSize {
  width: number;
  height: number;
}

/** Last-used detached window size (persisted in the main window). New windows
 *  open at this size so a preferred size sticks across the session. */
function loadRuleWindowSize(): RuleWindowSize {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    if (
      raw &&
      typeof raw.width === "number" &&
      typeof raw.height === "number" &&
      raw.width >= MIN_SIZE.width &&
      raw.height >= MIN_SIZE.height
    ) {
      return { width: Math.round(raw.width), height: Math.round(raw.height) };
    }
  } catch {
    /* ignore parse / privacy-mode errors */
  }
  return DEFAULT_SIZE;
}

export function saveRuleWindowSize(size: RuleWindowSize): void {
  if (size.width < MIN_SIZE.width || size.height < MIN_SIZE.height) return;
  try {
    localStorage.setItem(
      SIZE_KEY,
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
    );
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export interface RulesChangedPayload {
  /** Window label that emitted the change, so listeners can ignore their own. */
  source: string;
  /** The specific rule that changed, or null for "reload everything" (undo/redo,
   *  where the affected set is unknown). Lets a window ignore saves to OTHER rules
   *  so an unrelated window's autosave never clobbers this one's in-progress edit. */
  ruleId: string | null;
}

export interface RuleWindowClosedPayload {
  ruleId: string;
}

interface RuleWindowsFlushRequestPayload {
  requestId: string;
  /** Process shutdown closes the detached writer immediately after its save,
   * eliminating the post-acknowledgement edit gap. Other barriers only flush. */
  closeAfterFlush?: boolean;
}

interface RuleWindowFlushResultPayload {
  requestId: string;
  ruleId: string;
  ok: boolean;
  error?: string;
}

const LABEL_PREFIX = "rule-";

/** Tauri window labels allow [a-zA-Z0-9-/:_]; UUID rule ids already qualify. */
function ruleWindowLabel(ruleId: string): string {
  return LABEL_PREFIX + ruleId.replace(/[^a-zA-Z0-9\-/:_]/g, "_");
}

function isRuleWindowLabel(label: string): boolean {
  return label.startsWith(LABEL_PREFIX);
}

export function currentRuleWindowLabel(): string {
  return getCurrentWindow().label;
}

/** Open the detail window for a rule, or focus it if it is already open. */
export async function openOrFocusRuleWindow(
  ruleId: string,
  scenarioId: string,
  title: string,
): Promise<void> {
  const url = `index.html?rule=${encodeURIComponent(ruleId)}&scenario=${encodeURIComponent(
    scenarioId,
  )}`;
  const size = loadRuleWindowSize();
  await openOrFocusWindow(ruleWindowLabel(ruleId), {
    url,
    title: title || "Rule",
    width: size.width,
    height: size.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
  });
}

/** Rule ids that currently have an open detail window (main-window recovery). */
export async function listOpenRuleIds(): Promise<string[]> {
  const wins = await WebviewWindow.getAll();
  return wins
    .map((w) => w.label)
    .filter(isRuleWindowLabel)
    .map((label) => label.slice(LABEL_PREFIX.length));
}

export function emitRulesChanged(source: string, ruleId: string | null = null): void {
  void emit(RULES_CHANGED, { source, ruleId } satisfies RulesChangedPayload);
}

/** A detail window broadcasts its new size; the main window persists it (this
 *  avoids relying on cross-window localStorage sharing). */
export function emitRuleWindowResized(size: RuleWindowSize): void {
  void emit(RULE_WINDOW_RESIZED, size satisfies RuleWindowSize);
}

export function onRuleWindowResized(handler: (p: RuleWindowSize) => void): Promise<UnlistenFn> {
  return listen<RuleWindowSize>(RULE_WINDOW_RESIZED, (e) => handler(e.payload));
}

export function onRulesChanged(handler: (p: RulesChangedPayload) => void): Promise<UnlistenFn> {
  return listen<RulesChangedPayload>(RULES_CHANGED, (e) => handler(e.payload));
}

export function onRuleWindowClosed(
  handler: (p: RuleWindowClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<RuleWindowClosedPayload>(RULE_WINDOW_CLOSED, (e) => handler(e.payload));
}

/** Register one detached editor in the main-window shutdown handshake. */
export function onRuleWindowsFlushRequested(
  ruleId: string,
  handler: (closeAfterFlush: boolean) => Promise<void>,
): Promise<UnlistenFn> {
  return listen<RuleWindowsFlushRequestPayload>(RULE_WINDOWS_FLUSH_REQUESTED, (event) => {
    void Promise.resolve()
      .then(() => handler(event.payload.closeAfterFlush === true))
      .then(
        () =>
          emit(RULE_WINDOW_FLUSH_FINISHED, {
            requestId: event.payload.requestId,
            ruleId,
            ok: true,
          } satisfies RuleWindowFlushResultPayload),
        (error: unknown) =>
          emit(RULE_WINDOW_FLUSH_FINISHED, {
            requestId: event.payload.requestId,
            ruleId,
            ok: false,
            error: String(error),
          } satisfies RuleWindowFlushResultPayload),
      )
      .catch(() => {});
  });
}

function flushRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/** Wait for every currently-open detached rule editor to persist before the
 * main window destroys the process. A closing window counts as success because
 * its own close path already requires a successful flush before destruction. */
export async function flushDetachedRuleWindows(
  timeoutMs = 5_000,
  closeAfterFlush = false,
): Promise<void> {
  const pending = new Set(await listOpenRuleIds());
  if (pending.size === 0) return;

  const requestId = flushRequestId();
  let settle!: (error?: Error) => void;
  const result = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });
  let firstError: Error | undefined;
  let settled = false;
  let ready = false;
  const finishRule = (ruleId: string, error?: Error) => {
    if (!pending.delete(ruleId)) return;
    firstError ??= error;
    if (ready && pending.size === 0 && !settled) {
      settled = true;
      settle(firstError);
    }
  };

  let unlistenResult: UnlistenFn | undefined;
  let unlistenClosed: UnlistenFn | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    unlistenResult = await listen<RuleWindowFlushResultPayload>(
      RULE_WINDOW_FLUSH_FINISHED,
      (event) => {
        if (event.payload.requestId !== requestId) return;
        finishRule(
          event.payload.ruleId,
          event.payload.ok
            ? undefined
            : new Error(event.payload.error || `Rule ${event.payload.ruleId} could not be saved.`),
        );
      },
    );
    unlistenClosed = await onRuleWindowClosed(({ ruleId }) => finishRule(ruleId));

    // Drop windows that closed while the listeners were being installed. New
    // windows cannot normally be opened during shutdown, but include one if it
    // did appear before the request was emitted.
    const stillOpen = new Set(await listOpenRuleIds());
    for (const ruleId of pending) {
      if (!stillOpen.has(ruleId)) finishRule(ruleId);
    }
    for (const ruleId of stillOpen) pending.add(ruleId);
    ready = true;
    if (pending.size === 0) return;

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      settle(
        new Error(
          `Timed out waiting for ${pending.size} detached rule editor${pending.size === 1 ? "" : "s"} to save.`,
        ),
      );
    }, timeoutMs);
    await emit(RULE_WINDOWS_FLUSH_REQUESTED, {
      requestId,
      closeAfterFlush,
    } satisfies RuleWindowsFlushRequestPayload);
    const error = await result;
    if (error) throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unlistenResult?.();
    unlistenClosed?.();
  }
}
