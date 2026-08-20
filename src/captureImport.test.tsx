import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { CaptureImportRunContext, CaptureImportStatus } from "./captureImport";
import { CaptureImportProgress, useCaptureImport } from "./captureImport";
import type { FlowSummary } from "./types";
import "./styles.css";

const apiMocks = vi.hoisted(() => ({
  reserveCaptureImport: vi.fn<() => Promise<number>>(),
  cancelCaptureImport: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("./ipc", () => ({ api: apiMocks }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Operation = (context: CaptureImportRunContext) => Promise<number>;

function Harness({ operations }: { operations: Operation[] }) {
  const capture = useCaptureImport();
  const next = useRef(0);
  const [result, setResult] = useState("");
  const start = () => {
    const operation = operations[next.current++];
    void capture
      .run(operation)
      .then((outcome) => {
        setResult(outcome.cancelled ? "cancelled" : `result ${outcome.value}`);
      })
      .catch((error: unknown) => setResult(`error ${String(error)}`));
  };
  return (
    <>
      <button type="button" onClick={start}>
        Start import
      </button>
      <CaptureImportProgress status={capture.status} onCancel={capture.cancel} />
      <output>{result}</output>
    </>
  );
}

function SummaryHarness({ operation }: { operation: Operation }) {
  const capture = useCaptureImport();
  const [received, setReceived] = useState(0);
  const [settled, setSettled] = useState(false);
  const start = () => {
    void capture
      .run(operation, (summaries) => setReceived((count) => count + summaries.length))
      .then(() => setSettled(true));
  };
  return (
    <>
      <button type="button" onClick={start}>
        Start compare import
      </button>
      <CaptureImportProgress status={capture.status} onCancel={capture.cancel} />
      <output>{`received ${received}; settled ${settled}`}</output>
    </>
  );
}

const importedSummary: FlowSummary = {
  id: "imported-1",
  seq: 1,
  method: "GET",
  host: "example.test",
  path: "/",
  scheme: "https",
  status: 200,
  mime: "text/plain",
  kind: "doc",
  reqSize: 0,
  respSize: 0,
  durationMs: 1,
  ttfbMs: 1,
  matchedRule: null,
  timestampMs: 1,
  comment: null,
  availability: null,
  imported: true,
  extra: {},
};

function progress(overrides: Partial<CaptureImportStatus> = {}): CaptureImportStatus {
  return {
    stage: "reading",
    completed: 50,
    total: 100,
    cancelable: true,
    ...overrides,
  };
}

describe("CaptureImportProgress", () => {
  it("uses native determinate progress semantics and exposes cancellation", async () => {
    const onCancel = vi.fn();
    const screen = await render(<CaptureImportProgress status={progress()} onCancel={onCancel} />);

    const bar = screen.getByRole("progressbar", { name: "Reading capture file" });
    await expect.element(bar).toHaveAttribute("max", "100");
    await expect.element(bar).toHaveAttribute("value", "50");
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("is honestly indeterminate and removes cancel during atomic finalization", async () => {
    const screen = await render(
      <CaptureImportProgress
        status={progress({ stage: "finalizing", completed: 0, total: null, cancelable: false })}
        onCancel={vi.fn()}
      />,
    );

    const bar = screen.getByRole("progressbar", { name: "Adding requests" });
    await expect.element(bar).not.toHaveAttribute("value");
    await expect.element(screen.getByText("Working…")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});

describe("useCaptureImport", () => {
  let nextOperationId = 0;

  beforeEach(() => {
    nextOperationId = 0;
    apiMocks.reserveCaptureImport.mockReset();
    apiMocks.reserveCaptureImport.mockImplementation(() => Promise.resolve(++nextOperationId));
    apiMocks.cancelCaptureImport.mockClear();
  });

  it("ignores a replaced operation's late rejection and keeps the newer status", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const contexts: CaptureImportRunContext[] = [];
    const operations = [first, second].map(
      (pending): Operation =>
        (context) => {
          contexts.push(context);
          return pending.promise;
        },
    );
    const screen = await render(<Harness operations={operations} />);
    const start = screen.getByRole("button", { name: "Start import" });

    await start.click();
    contexts[0].onEvent({ type: "started", operationId: contexts[0].operationId });
    contexts[0].onEvent({
      type: "progress",
      operationId: contexts[0].operationId,
      stage: "parsing",
      completed: 10,
      total: 100,
      cancelable: true,
    });
    await start.click();
    expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(contexts[0].operationId);
    contexts[1].onEvent({ type: "started", operationId: contexts[1].operationId });
    contexts[1].onEvent({
      type: "progress",
      operationId: contexts[1].operationId,
      stage: "extracting",
      completed: 2,
      total: 8,
      cancelable: true,
    });
    contexts[0].onEvent({
      type: "progress",
      operationId: contexts[0].operationId,
      stage: "finalizing",
      completed: 100,
      total: 100,
      cancelable: false,
    });

    first.reject(new Error("older import failed late"));
    await expect.element(screen.getByText("Extracting SAZ files")).toBeVisible();
    await expect.element(screen.getByText("2 of 8")).toBeVisible();
    second.resolve(2);
    await expect.element(screen.getByText("result 2")).toBeVisible();
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();
  });

  it("treats user cancellation as cleanup instead of an error", async () => {
    const pending = deferred<number>();
    let context!: CaptureImportRunContext;
    const screen = await render(
      <Harness
        operations={[
          (runContext) => {
            context = runContext;
            return pending.promise;
          },
        ]}
      />,
    );
    await screen.getByRole("button", { name: "Start import" }).click();
    context.onEvent({ type: "started", operationId: context.operationId });
    context.onEvent({
      type: "progress",
      operationId: context.operationId,
      stage: "reading",
      completed: 2,
      total: 10,
      cancelable: true,
    });

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(context.signal.aborted).toBe(true);
    expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(context.operationId);
    await expect.element(screen.getByText("Canceling capture import")).toBeVisible();
    context.onEvent({
      type: "progress",
      operationId: context.operationId,
      stage: "finalizing",
      completed: 10,
      total: 10,
      cancelable: false,
    });
    await expect.element(screen.getByText("Canceling capture import")).toBeVisible();

    pending.reject(new Error("Capture import cancelled"));
    await expect.element(screen.getByText("cancelled")).toBeVisible();
    await expect.element(screen.getByText(/error/)).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();
  });

  it("keeps Compare finalizing through its last summary batch until invoke success", async () => {
    const pending = deferred<number>();
    let context!: CaptureImportRunContext;
    const screen = await render(
      <SummaryHarness
        operation={(runContext) => {
          context = runContext;
          return pending.promise;
        }}
      />,
    );
    await screen.getByRole("button", { name: "Start compare import" }).click();
    context.onEvent({ type: "started", operationId: context.operationId });
    context.onEvent({
      type: "progress",
      operationId: context.operationId,
      stage: "finalizing",
      completed: 1,
      total: 1,
      cancelable: false,
    });
    context.onEvent({
      type: "summaries",
      operationId: context.operationId,
      batchIndex: 0,
      summaries: [importedSummary],
    });

    await expect.element(screen.getByText("received 1; settled false")).toBeVisible();
    await expect.element(screen.getByText("Adding requests")).toBeVisible();
    pending.resolve(1);
    await expect.element(screen.getByText("received 1; settled true")).toBeVisible();
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();

    context.onEvent({
      type: "progress",
      operationId: context.operationId,
      stage: "finalizing",
      completed: 1,
      total: 1,
      cancelable: false,
    });
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();
  });

  it("releases a reservation after a pre-claim failure and permits a sequential success", async () => {
    const failed = deferred<number>();
    const succeeded = deferred<number>();
    let failedContext!: CaptureImportRunContext;
    const screen = await render(
      <Harness
        operations={[
          (context) => {
            failedContext = context;
            return failed.promise;
          },
          () => succeeded.promise,
        ]}
      />,
    );
    const start = screen.getByRole("button", { name: "Start import" });

    await start.click();
    failed.reject(new Error("bad HAR"));
    await expect.element(screen.getByText(/error Error: bad HAR/)).toBeVisible();
    expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(failedContext.operationId);
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();

    await start.click();
    succeeded.resolve(7);
    await expect.element(screen.getByText("result 7")).toBeVisible();
    await expect.element(screen.getByLabelText("Capture import")).not.toBeInTheDocument();
  });

  it("serializes pending reservations so a stale run cannot start after its replacement", async () => {
    const firstReservation = deferred<number>();
    apiMocks.reserveCaptureImport
      .mockImplementationOnce(() => firstReservation.promise)
      .mockResolvedValueOnce(22);
    const staleOperation = vi.fn<Operation>(() => Promise.resolve(1));
    const replacement = deferred<number>();
    let replacementContext!: CaptureImportRunContext;
    const screen = await render(
      <Harness
        operations={[
          staleOperation,
          (context) => {
            replacementContext = context;
            return replacement.promise;
          },
        ]}
      />,
    );
    const start = screen.getByRole("button", { name: "Start import" });

    await start.click();
    await start.click();
    expect(apiMocks.reserveCaptureImport).toHaveBeenCalledOnce();

    firstReservation.resolve(21);
    await vi.waitFor(() => expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(21));
    await vi.waitFor(() => expect(apiMocks.reserveCaptureImport).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(replacementContext.operationId).toBe(22));
    expect(staleOperation).not.toHaveBeenCalled();

    replacement.resolve(2);
    await expect.element(screen.getByText("result 2")).toBeVisible();
  });

  it("aborts frontend work and cancels the backend operation on unmount", async () => {
    const pending = deferred<number>();
    let context!: CaptureImportRunContext;
    const screen = await render(
      <Harness
        operations={[
          (runContext) => {
            context = runContext;
            return pending.promise;
          },
        ]}
      />,
    );
    await screen.getByRole("button", { name: "Start import" }).click();
    context.onEvent({ type: "started", operationId: context.operationId });

    await screen.unmount();
    expect(context.signal.aborted).toBe(true);
    expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(context.operationId);
  });

  it("cancels a backend operation that starts after its window unmounts", async () => {
    const pending = deferred<number>();
    let context!: CaptureImportRunContext;
    const screen = await render(
      <Harness
        operations={[
          (runContext) => {
            context = runContext;
            return pending.promise;
          },
        ]}
      />,
    );
    await screen.getByRole("button", { name: "Start import" }).click();
    await screen.unmount();

    context.onEvent({ type: "started", operationId: context.operationId });

    expect(apiMocks.cancelCaptureImport).toHaveBeenCalledWith(context.operationId);
  });
});
