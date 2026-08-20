import { useEffect, useRef, useState } from "react";

import { api } from "./ipc";
import type { CaptureImportEvent, CaptureImportStage, FlowSummary } from "./types";
import { Button } from "./components/ui/Button";
import { readFileAsBase64 } from "./captureDrop";

export type CaptureImportUiStage = CaptureImportStage | "waiting" | "canceling";

export interface CaptureImportStatus {
  stage: CaptureImportUiStage;
  completed: number;
  total: number | null;
  cancelable: boolean;
}

export interface LocalCaptureProgress {
  stage: CaptureImportStage;
  completed: number;
  total: number | null;
  cancelable: boolean;
}

export interface CaptureImportRunContext {
  operationId: number;
  signal: AbortSignal;
  onEvent: (event: CaptureImportEvent) => void;
  report: (progress: LocalCaptureProgress) => void;
}

type CaptureImportRunResult<T> = { cancelled: false; value: T } | { cancelled: true };

interface ActiveImport {
  generation: number;
  controller: AbortController;
  operationId: number | null;
  stageRank: number;
  completed: number;
}

const STAGE_RANK: Record<CaptureImportStage, number> = {
  reading: 0,
  decoding: 1,
  parsing: 2,
  extracting: 3,
  processing: 4,
  finalizing: 5,
};

function isCancelled(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    String(error).toLowerCase().includes("capture import cancelled")
  );
}

/**
 * Own one visible import operation for a window. Starting a replacement aborts
 * the older frontend read and asks Rust to cancel its operation id. Generation
 * checks make every late event/result inert, including after component unmount.
 * Progress channels are intentionally nonterminal: the invoke's settlement is
 * authoritative, so post-commit summary batches remain covered by Finalizing.
 */
export function useCaptureImport() {
  const [status, setStatus] = useState<CaptureImportStatus | null>(null);
  const generation = useRef(0);
  const active = useRef<ActiveImport | null>(null);
  const mounted = useRef(true);
  // Preserve invocation order even when two reserve IPC calls would otherwise
  // be scheduled out of order. A successful reservation releases the queue
  // immediately; the picker/parser itself remains freely replaceable.
  const reservationTail = useRef<Promise<void>>(Promise.resolve());

  function stop(operation: ActiveImport | null): void {
    if (!operation) return;
    operation.controller.abort();
    if (operation.operationId !== null) {
      void api.cancelCaptureImport(operation.operationId).catch(() => {});
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const operation = active.current;
      active.current = null;
      stop(operation);
    };
  }, []);

  async function run<T>(
    operation: (context: CaptureImportRunContext) => Promise<T>,
    onSummaries?: (summaries: FlowSummary[]) => void,
    reserve: () => Promise<number> = api.reserveCaptureImport,
  ): Promise<CaptureImportRunResult<T>> {
    stop(active.current);
    const current: ActiveImport = {
      generation: ++generation.current,
      controller: new AbortController(),
      operationId: null,
      stageRank: -1,
      completed: 0,
    };
    active.current = current;
    if (mounted.current) {
      setStatus({ stage: "waiting", completed: 0, total: null, cancelable: false });
    }

    const isCurrent = () => mounted.current && active.current === current;
    const applyProgress = (progress: LocalCaptureProgress) => {
      if (!isCurrent()) return;
      const rank = STAGE_RANK[progress.stage];
      if (rank < current.stageRank) return;
      if (rank === current.stageRank && progress.completed < current.completed) return;
      current.stageRank = rank;
      current.completed = progress.completed;
      setStatus(progress);
    };
    const onEvent = (event: CaptureImportEvent) => {
      if (event.type === "started") {
        // Started only confirms that Rust claimed the token reserved below. A
        // delayed signal must never replace this operation's authoritative id.
        if (!isCurrent() || current.operationId !== event.operationId) {
          void api.cancelCaptureImport(event.operationId).catch(() => {});
          return;
        }
        if (current.controller.signal.aborted) {
          void api.cancelCaptureImport(event.operationId).catch(() => {});
        } else if (current.stageRank < 0) {
          setStatus({ stage: "waiting", completed: 0, total: null, cancelable: true });
        }
        return;
      }
      if (!isCurrent()) return;
      if (current.operationId !== event.operationId) return;
      if (current.controller.signal.aborted) return;
      if (event.type === "summaries") {
        onSummaries?.(event.summaries);
        return;
      }
      applyProgress(event);
    };

    try {
      const predecessor = reservationTail.current.catch(() => {});
      const reservation = predecessor.then(async () => {
        const operationId = await reserve();
        current.operationId = operationId;
        if (!isCurrent() || current.controller.signal.aborted) {
          await api.cancelCaptureImport(operationId).catch(() => {});
          throw new DOMException("Capture import cancelled", "AbortError");
        }
        setStatus({ stage: "waiting", completed: 0, total: null, cancelable: true });
        return operationId;
      });
      reservationTail.current = reservation.then(
        () => {},
        () => {},
      );
      const operationId = await reservation;
      const value = await operation({
        operationId,
        signal: current.controller.signal,
        onEvent,
        report: applyProgress,
      });
      if (!isCurrent()) return { cancelled: true };
      active.current = null;
      setStatus(null);
      return { cancelled: false, value };
    } catch (error) {
      if (!isCurrent()) return { cancelled: true };
      const cancelled = current.controller.signal.aborted || isCancelled(error);
      // The failure may precede the Rust import command (for example a local
      // FileReader error), so explicitly release the already-reserved token.
      // Exact-id cancellation is harmless after a command has already settled.
      stop(current);
      active.current = null;
      setStatus(null);
      if (cancelled) return { cancelled: true };
      throw error;
    }
  }

  function cancel(): void {
    const current = active.current;
    if (!current || !status?.cancelable) return;
    stop(current);
    setStatus({ stage: "canceling", completed: 0, total: null, cancelable: false });
  }

  return { status, run, cancel };
}

export function readCaptureForImport(
  file: File,
  { signal, report }: CaptureImportRunContext,
): Promise<string> {
  return readFileAsBase64(file, {
    signal,
    onProgress: (completed, total) =>
      report({ stage: "reading", completed, total, cancelable: true }),
  });
}

const STAGE_LABEL: Record<CaptureImportUiStage, string> = {
  waiting: "Starting capture import",
  reading: "Reading capture file",
  decoding: "Decoding dropped file",
  parsing: "Parsing HAR",
  extracting: "Extracting SAZ files",
  processing: "Preparing requests",
  finalizing: "Adding requests",
  canceling: "Canceling capture import",
};

function progressDetail(status: CaptureImportStatus): string {
  if (status.total === null || status.total <= 0) return "Working…";
  if (["reading", "decoding", "parsing"].includes(status.stage)) {
    const percent = Math.min(100, Math.round((status.completed / status.total) * 100));
    return `${percent}%`;
  }
  return `${status.completed.toLocaleString()} of ${status.total.toLocaleString()}`;
}

export function CaptureImportProgress({
  status,
  onCancel,
}: {
  status: CaptureImportStatus | null;
  onCancel: () => void;
}) {
  if (!status) return null;
  const label = STAGE_LABEL[status.stage];
  const determinate = status.total !== null && status.total > 0;
  return (
    <section className="capture-import-progress" aria-label="Capture import">
      <div className="capture-import-copy">
        <strong role="status" aria-live="polite" key={status.stage}>
          {label}
        </strong>
        <span className="muted">{progressDetail(status)}</span>
      </div>
      <progress
        aria-label={label}
        max={determinate ? status.total! : undefined}
        value={determinate ? Math.min(status.completed, status.total!) : undefined}
      />
      {status.cancelable && (
        <Button variant="ghost" size="small" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </section>
  );
}
