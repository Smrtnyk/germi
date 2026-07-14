import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

interface WindowFlushRequestPayload {
  requestId: string;
  closeAfterFlush?: boolean;
}

interface WindowFlushResultPayload {
  requestId: string;
  targetId: string;
  ok: boolean;
  error?: string;
}

interface WindowFlushResponderOptions {
  requestEvent: string;
  resultEvent: string;
  targetId: string;
  flush: (closeAfterFlush: boolean) => Promise<void>;
}

/** Register one detached writer in a main-window shutdown handshake. */
export function onWindowFlushRequested({
  requestEvent,
  resultEvent,
  targetId,
  flush,
}: WindowFlushResponderOptions): Promise<UnlistenFn> {
  return listen<WindowFlushRequestPayload>(requestEvent, (event) => {
    void Promise.resolve()
      .then(() => flush(event.payload.closeAfterFlush === true))
      .then(
        () =>
          emit(resultEvent, {
            requestId: event.payload.requestId,
            targetId,
            ok: true,
          } satisfies WindowFlushResultPayload),
        (error: unknown) =>
          emit(resultEvent, {
            requestId: event.payload.requestId,
            targetId,
            ok: false,
            error: String(error),
          } satisfies WindowFlushResultPayload),
      )
      // A successful shutdown may destroy the responder before its acknowledgement
      // is emitted. The requester also treats the shell-owned close event as success.
      .catch(() => {});
  });
}

interface FlushDetachedWindowsOptions {
  requestEvent: string;
  resultEvent: string;
  closeAfterFlush: boolean;
  timeoutMs: number;
  listOpenTargetIds: () => Promise<string[]>;
  onTargetClosed: (handler: (targetId: string) => void) => Promise<UnlistenFn>;
  saveError: (targetId: string) => string;
  timeoutError: (pendingCount: number) => string;
}

function flushRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/** Ask every currently-open detached writer to persist, treating a shell close
 * as success because each detached window flushes before destroying itself. */
export async function flushDetachedWindows({
  requestEvent,
  resultEvent,
  closeAfterFlush,
  timeoutMs,
  listOpenTargetIds,
  onTargetClosed,
  saveError,
  timeoutError,
}: FlushDetachedWindowsOptions): Promise<void> {
  const pending = new Set(await listOpenTargetIds());
  if (pending.size === 0) return;

  const completed = new Set<string>();
  const requestId = flushRequestId();
  let settle!: (error?: Error) => void;
  const result = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });
  let firstError: Error | undefined;
  let settled = false;
  let ready = false;
  const finishTarget = (targetId: string, error?: Error) => {
    completed.add(targetId);
    if (!pending.delete(targetId)) return;
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
    unlistenResult = await listen<WindowFlushResultPayload>(resultEvent, (event) => {
      if (event.payload.requestId !== requestId) return;
      finishTarget(
        event.payload.targetId,
        event.payload.ok
          ? undefined
          : new Error(event.payload.error || saveError(event.payload.targetId)),
      );
    });
    unlistenClosed = await onTargetClosed((targetId) => finishTarget(targetId));

    // Reconcile windows that opened or closed while the asynchronous listeners
    // were being installed. A close already observed must not be added back.
    const stillOpen = new Set(await listOpenTargetIds());
    for (const targetId of pending) {
      if (!stillOpen.has(targetId)) finishTarget(targetId);
    }
    for (const targetId of stillOpen) {
      if (!completed.has(targetId)) pending.add(targetId);
    }
    ready = true;
    if (pending.size === 0) return;

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      settle(new Error(timeoutError(pending.size)));
    }, timeoutMs);
    await emit(requestEvent, {
      requestId,
      closeAfterFlush,
    } satisfies WindowFlushRequestPayload);
    const error = await result;
    if (error) throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unlistenResult?.();
    unlistenClosed?.();
  }
}
