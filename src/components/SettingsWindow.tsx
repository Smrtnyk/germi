import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  announceSettingsWindowReady,
  onSettingsOperationResult,
  onSettingsShutdownRequest,
  onSettingsWindowState,
  requestSettingsOperation,
  requestSettingsPreview,
  requestSettingsPreviewResume,
  sendSettingsShutdownResult,
} from "../settingsWindowEvents";
import type {
  SettingsWindowAction,
  SettingsAppearance,
  SettingsWindowResult,
  SettingsWindowShutdownRequest,
  SettingsWindowSnapshot,
} from "../settingsWindowProtocol";
import { SettingsWindowSession } from "../settingsWindowSession";
import { closeSettingsWindow } from "../settingsWindow";
import { baselineFromSnapshot, draftFromSnapshot } from "../settingsReconciliation";
import type { SettingsDialogDraft } from "../settingsDraft";
import type { ProxySettings, SettingsSectionSummary } from "../types";
import { useNativeWindowCloseRequest } from "../useSafeWindowClose";
import { ToastHost, ToastProvider, useToasts } from "../toast";
import { Button } from "./ui/Button";
import { SettingsDialog } from "./SettingsDialog";

function resultError(result: SettingsWindowResult): Error {
  return new Error(result.error ?? "The main window rejected the Settings operation.");
}

function useSettingsOperation(
  sessionId: string,
  sessionRef: MutableRefObject<SettingsWindowSession | null>,
  acceptSnapshot: (snapshot: SettingsWindowSnapshot, rebaseline?: boolean) => void,
) {
  const requestBusyRef = useRef(false);
  const saveBusyRef = useRef(false);
  const queuedCloseRef = useRef(false);
  const [closeRequest, setCloseRequest] = useState(0);

  function releaseQueuedClose(): void {
    if (requestBusyRef.current || saveBusyRef.current || !queuedCloseRef.current) return;
    queuedCloseRef.current = false;
    setCloseRequest((value) => value + 1);
  }

  const requestClose = useCallback(() => {
    if (requestBusyRef.current || saveBusyRef.current) {
      queuedCloseRef.current = true;
      return;
    }
    setCloseRequest((value) => value + 1);
  }, []);

  async function operation(action: SettingsWindowAction): Promise<SettingsWindowResult> {
    if (requestBusyRef.current || saveBusyRef.current)
      throw new Error("Another Settings operation is already in progress.");
    requestBusyRef.current = true;
    try {
      const result: SettingsWindowResult = await (sessionRef.current?.request(action) ??
        Promise.resolve<SettingsWindowResult>({
          sessionId,
          requestId: "unavailable",
          ok: false,
          error: "The Settings window is not connected to Germi.",
        }));
      if (result.snapshot)
        acceptSnapshot(
          result.snapshot,
          result.ok && (action.kind === "applyImport" || action.kind === "save"),
        );
      if (!result.ok) throw resultError(result);
      return result;
    } finally {
      requestBusyRef.current = false;
      releaseQueuedClose();
    }
  }

  function onSavingChange(saving: boolean): void {
    saveBusyRef.current = saving;
    releaseQueuedClose();
  }

  return { closeRequest, requestClose, operation, onSavingChange };
}

function useNativeCloseRequests(requestClose: () => void, setError: (error: string) => void): void {
  useNativeWindowCloseRequest(requestClose, (cause) => setError(String(cause)));

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);
}

interface WindowCloseOptions {
  sessionId: string;
  shutdownRef: MutableRefObject<SettingsWindowShutdownRequest | null>;
  snapshotRef: MutableRefObject<SettingsWindowSnapshot | null>;
  requestDialogClose: () => void;
  setError: (error: string) => void;
}

function useSettingsWindowClose({
  sessionId,
  shutdownRef,
  snapshotRef,
  requestDialogClose,
  setError,
}: WindowCloseOptions) {
  const answerShutdown = useCallback(
    async (ok: boolean, shutdownError?: string): Promise<void> => {
      const request = shutdownRef.current;
      if (!request) return;
      await sendSettingsShutdownResult({ ...request, ok, error: shutdownError });
      if (shutdownRef.current === request) shutdownRef.current = null;
    },
    [shutdownRef],
  );

  const close = useCallback(async (): Promise<void> => {
    setError("");
    try {
      await closeSettingsWindow();
    } catch (cause) {
      let message = `Could not close Settings: ${String(cause)}`;
      try {
        await requestSettingsPreviewResume({ sessionId });
      } catch (resumeError) {
        message += `; could not resume appearance previews: ${String(resumeError)}`;
      }
      try {
        await answerShutdown(false, message);
      } catch (replyError) {
        message += `; could not cancel app close: ${String(replyError)}`;
      }
      setError(message);
      throw Object.assign(new Error(message), { cause });
    }
  }, [answerShutdown, sessionId, setError]);

  const requestClose = useCallback(() => {
    if (snapshotRef.current === null) void close().catch(() => {});
    else requestDialogClose();
  }, [close, requestDialogClose, snapshotRef]);
  useNativeCloseRequests(requestClose, setError);
  return { answerShutdown, close, requestClose };
}

interface WindowConnectionOptions {
  sessionId: string;
  sessionRef: MutableRefObject<SettingsWindowSession | null>;
  shutdownRef: MutableRefObject<SettingsWindowShutdownRequest | null>;
  acceptSnapshot: (snapshot: SettingsWindowSnapshot) => void;
  requestClose: () => void;
  setError: (error: string) => void;
}

function useSettingsWindowConnection({
  sessionId,
  sessionRef,
  shutdownRef,
  acceptSnapshot,
  requestClose,
  setError,
}: WindowConnectionOptions): void {
  useEffect(() => {
    const session = new SettingsWindowSession({
      sessionId,
      transport: {
        onState: onSettingsWindowState,
        onResult: onSettingsOperationResult,
        onShutdown: onSettingsShutdownRequest,
        announceReady: announceSettingsWindowReady,
        request: requestSettingsOperation,
      },
      onState: ({ snapshot: next }) => acceptSnapshot(next),
      onShutdown: (request) => {
        shutdownRef.current = request;
        void getCurrentWindow()
          .setFocus()
          .catch(() => {});
        requestClose();
      },
      onError: setError,
    });
    sessionRef.current = session;
    void session.start();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [acceptSnapshot, requestClose, sessionId, sessionRef, setError, shutdownRef]);
}

function useSettingsPreview(sessionId: string, setError: (error: string) => void) {
  const previewRevisionRef = useRef(0);
  return useCallback(
    (appearance: SettingsAppearance) => {
      void requestSettingsPreview({
        sessionId,
        revision: ++previewRevisionRef.current,
        appearance,
      }).catch((cause: unknown) => setError(`Could not preview appearance: ${String(cause)}`));
    },
    [sessionId, setError],
  );
}

function SettingsWindowLoading({ error, close }: { error: string | null; close: () => void }) {
  return (
    <main className="settings-window settings-window-loading">
      <h1>Settings</h1>
      <p className="muted">Connecting to the main Germi window…</p>
      {error && (
        <p className="settings-err" role="alert">
          {error}
        </p>
      )}
      <Button onClick={close}>Close Settings</Button>
    </main>
  );
}

interface SettingsWindowContentProps {
  snapshot: SettingsWindowSnapshot;
  baseline: SettingsWindowSnapshot;
  settingsOperation: ReturnType<typeof useSettingsOperation>;
  previewAppearance: (appearance: SettingsAppearance) => void;
  close: () => Promise<void>;
  answerShutdown: (ok: boolean, shutdownError?: string) => Promise<void>;
  error: string | null;
  toasts: ReturnType<typeof useToasts>;
}

function SettingsWindowContent({
  snapshot,
  baseline,
  settingsOperation,
  previewAppearance,
  close,
  answerShutdown,
  error,
  toasts,
}: SettingsWindowContentProps) {
  return (
    <ToastProvider value={toasts.notify}>
      <SettingsDialog
        standalone
        {...snapshot}
        onCaChanged={() => {}}
        onImportApplied={() => {}}
        onFlushSettings={() => Promise.resolve()}
        onSave={async (draft: SettingsDialogDraft) => {
          const result = await settingsOperation.operation({
            kind: "save",
            baseline: baselineFromSnapshot(baseline),
            draft,
          });
          if (!result.snapshot) throw new Error("Saved Settings state is unavailable.");
          return draftFromSnapshot(result.snapshot);
        }}
        baselineDraft={draftFromSnapshot(baseline)}
        onGetSettingsSections={async (): Promise<SettingsSectionSummary[]> => {
          const result = await settingsOperation.operation({ kind: "getExportSections" });
          return result.sections ?? [];
        }}
        onExportSettings={async (sections) => {
          const result = await settingsOperation.operation({ kind: "export", sections });
          return result.picked ?? false;
        }}
        onPeekSettingsImport={async () => {
          const result = await settingsOperation.operation({ kind: "peekImport" });
          return result.sections ?? null;
        }}
        onApplySettingsImport={async (sections): Promise<ProxySettings> => {
          const result = await settingsOperation.operation({ kind: "applyImport", sections });
          if (!result.snapshot) throw new Error("Imported Settings state is unavailable.");
          return result.snapshot.settings;
        }}
        onExportCa={async () => {
          const result = await settingsOperation.operation({ kind: "exportCa" });
          return result.picked ?? false;
        }}
        onRegenerateCa={async () => {
          await settingsOperation.operation({ kind: "regenerateCa" });
        }}
        onPreviewAppearance={previewAppearance}
        onClose={close}
        closeRequest={settingsOperation.closeRequest}
        onCloseRequestCancelled={() => {
          void answerShutdown(
            false,
            "App close was cancelled because Settings has unsaved changes.",
          ).catch(() => {});
        }}
        onSavingChange={settingsOperation.onSavingChange}
      />
      {error && (
        <div className="error-bar" role="alert">
          {error}
        </div>
      )}
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </ToastProvider>
  );
}

export function SettingsWindow({ sessionId }: { sessionId: string }) {
  const toasts = useToasts();
  const [windowState, setWindowState] = useState<{
    snapshot: SettingsWindowSnapshot | null;
    baseline: SettingsWindowSnapshot | null;
  }>({ snapshot: null, baseline: null });
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<SettingsWindowSession | null>(null);
  const shutdownRef = useRef<SettingsWindowShutdownRequest | null>(null);
  const snapshotRef = useRef<SettingsWindowSnapshot | null>(null);
  snapshotRef.current = windowState.snapshot;
  const acceptSnapshot = useCallback(
    (snapshot: SettingsWindowSnapshot, rebaseline = false) =>
      setWindowState((current) => ({
        snapshot,
        baseline: rebaseline || current.baseline === null ? snapshot : current.baseline,
      })),
    [],
  );
  const settingsOperation = useSettingsOperation(sessionId, sessionRef, acceptSnapshot);
  const requestDialogClose = settingsOperation.requestClose;
  const { answerShutdown, close, requestClose } = useSettingsWindowClose({
    sessionId,
    shutdownRef,
    snapshotRef,
    requestDialogClose,
    setError,
  });
  useSettingsWindowConnection({
    sessionId,
    sessionRef,
    shutdownRef,
    acceptSnapshot,
    requestClose,
    setError,
  });
  const previewAppearance = useSettingsPreview(sessionId, setError);

  const snapshot = windowState.snapshot;
  const baseline = windowState.baseline;
  if (!snapshot || !baseline) {
    return <SettingsWindowLoading error={error} close={() => void close().catch(() => {})} />;
  }

  return (
    <SettingsWindowContent
      snapshot={snapshot}
      baseline={baseline}
      settingsOperation={settingsOperation}
      previewAppearance={previewAppearance}
      close={close}
      answerShutdown={answerShutdown}
      error={error}
      toasts={toasts}
    />
  );
}
