import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { isEqual } from "es-toolkit";

import type { AutoLayout } from "./appState";
import { api } from "./ipc";
import type { Bindings } from "./shortcuts";
import {
  broadcastSettingsPreview,
  broadcastSettingsPreviewCleared,
  onSettingsOperation,
  onSettingsPreviewRequest,
  onSettingsPreviewResume,
  onSettingsShutdownResult,
  onSettingsWindowClosed,
  onSettingsWindowReady,
  onThemeSyncReady,
  requestSettingsShutdown,
  sendSettingsOperationResult,
  sendSettingsWindowState,
} from "./settingsWindowEvents";
import {
  createAuthoritativeSettingsPreviewReset,
  createSettingsPreviewOwner,
  createSettingsRequestOwner,
  type SettingsPreviewOwner,
  type SettingsRequestOwner,
  type SettingsAppearance,
  type SettingsWindowClosed,
  type SettingsWindowRequest,
  type SettingsWindowResult,
  type SettingsWindowSnapshot,
} from "./settingsWindowProtocol";
import {
  destroySettingsWindowFromMain,
  isSettingsWindowOpen,
  openOrFocusSettingsWindow,
} from "./settingsWindow";
import type { Notify } from "./toast";
import type { ProxySettings } from "./types";
import { useAsyncSubscription } from "./useTauriListen";
import { draftFromSnapshot, reconcileSettingsDraft } from "./settingsReconciliation";

interface Options {
  ready: boolean;
  settings: ProxySettings;
  getDurableSettings: () => ProxySettings;
  columnOrder: string[];
  shortcuts: Bindings;
  autoLayout: AutoLayout;
  running: boolean;
  portError: string | null;
  save: (
    draft: import("./settingsDraft").SettingsDialogDraft,
  ) => Promise<import("./settingsDraft").SettingsDialogDraft>;
  flush: () => Promise<void>;
  applyImported: (settings: ProxySettings) => Promise<ProxySettings>;
  refreshCa: () => void;
  clearListenerError: () => void;
  notify: Notify;
}

interface PendingShutdown {
  sessionId: string;
  requestId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SubscriptionContext {
  requestOwner: SettingsRequestOwner;
  previewOwner: SettingsPreviewOwner;
  pendingShutdownRef: MutableRefObject<PendingShutdown | null>;
  readySessionRef: MutableRefObject<string | null>;
  sessionRef: MutableRefObject<string | null>;
  snapshot: () => SettingsWindowSnapshot;
  handleRequest: (request: SettingsWindowRequest) => Promise<void>;
  clearPreview: (sessionId: string) => Promise<void>;
  resetPreview: () => Promise<void>;
  report: (message: string, error: unknown) => void;
  clearListenerError: () => void;
}

function stillOwnsSession(context: SubscriptionContext, sessionId: string): boolean {
  return context.sessionRef.current === sessionId && context.requestOwner.accepts(sessionId);
}

async function clearSettingsWindowOwnership(
  context: SubscriptionContext,
  sessionId: string,
): Promise<void> {
  if (!stillOwnsSession(context, sessionId)) return;
  const pending = context.pendingShutdownRef.current;
  try {
    await context.clearPreview(sessionId);
  } catch (error) {
    if (stillOwnsSession(context, sessionId)) {
      context.report("Could not restore saved Settings appearance", error);
      try {
        await context.resetPreview();
      } catch (resetError) {
        context.report("Could not retry saved Settings appearance", resetError);
      }
    }
  }
  if (pending?.sessionId === sessionId && context.pendingShutdownRef.current === pending) {
    clearTimeout(pending.timer);
    context.pendingShutdownRef.current = null;
    pending.resolve();
  }
  if (!stillOwnsSession(context, sessionId)) return;
  context.requestOwner.deactivate(sessionId);
  context.previewOwner.deactivate();
  context.readySessionRef.current = null;
  context.sessionRef.current = null;
  context.clearListenerError();
}

async function handleSettingsWindowClosed(
  context: SubscriptionContext,
  _event: SettingsWindowClosed,
): Promise<void> {
  const sessionId = context.sessionRef.current;
  if (!sessionId) {
    try {
      await context.resetPreview();
    } catch (error) {
      context.report("Could not restore saved Settings appearance", error);
    }
    context.clearListenerError();
    return;
  }
  // A label can be reused before the Rust fallback event reaches JavaScript.
  // If a Settings singleton exists now, the unscoped event belongs to an old
  // instance and must not invalidate the new session.
  try {
    const open = await isSettingsWindowOpen();
    if (!stillOwnsSession(context, sessionId) || open) return;
  } catch (error) {
    if (!stillOwnsSession(context, sessionId)) return;
    context.report("Could not verify the closed Settings window", error);
  }
  await clearSettingsWindowOwnership(context, sessionId);
}

function loadActiveSection(): string {
  try {
    return localStorage.getItem("germi.settingsSection") ?? "connections";
  } catch {
    return "connections";
  }
}

function appearanceOf(settings: ProxySettings): SettingsAppearance {
  return { theme: settings.theme, highlightColors: { ...settings.highlightColors } };
}

function useSettingsWindowSubscriptions(context: SubscriptionContext): void {
  useAsyncSubscription(
    onSettingsWindowReady,
    ({ sessionId }) => {
      if (!context.requestOwner.accepts(sessionId)) return;
      context.readySessionRef.current = sessionId;
      void sendSettingsWindowState({ sessionId, snapshot: context.snapshot() }).catch(
        (error: unknown) => context.report("Could not initialize Settings", error),
      );
    },
    (error) => context.report("Could not listen for Settings readiness", error),
  );

  useAsyncSubscription(
    onSettingsOperation,
    (request) => void context.handleRequest(request),
    (error) => context.report("Could not receive Settings requests", error),
  );

  useAsyncSubscription(
    onSettingsPreviewRequest,
    (request) => {
      if (!context.requestOwner.accepts(request.sessionId)) return;
      const accepted = context.previewOwner.accept(request);
      if (accepted)
        void broadcastSettingsPreview(accepted).catch((error: unknown) =>
          context.report("Could not preview Settings appearance", error),
        );
    },
    (error) => context.report("Could not receive Settings previews", error),
  );

  useAsyncSubscription(
    onSettingsPreviewResume,
    ({ sessionId }) => {
      if (!context.requestOwner.accepts(sessionId) || !context.requestOwner.idle()) return;
      context.previewOwner.activate(sessionId);
    },
    (error) => context.report("Could not resume Settings previews", error),
  );

  useAsyncSubscription(
    onThemeSyncReady,
    () => {
      const current = context.previewOwner.current();
      if (current) void broadcastSettingsPreview(current).catch(() => {});
    },
    (error) => context.report("Could not synchronize Settings appearance", error),
  );

  useAsyncSubscription(
    onSettingsShutdownResult,
    (result) => {
      const pending = context.pendingShutdownRef.current;
      if (
        !pending ||
        result.sessionId !== pending.sessionId ||
        result.requestId !== pending.requestId
      )
        return;
      // A cooperative reply may cancel shutdown, but successful close is only
      // acknowledged after Rust reports that the webview was destroyed.
      if (result.ok) return;
      clearTimeout(pending.timer);
      context.pendingShutdownRef.current = null;
      pending.reject(new Error(result.error ?? "Settings prevented app close."));
    },
    (error) => context.report("Could not receive Settings close result", error),
  );

  useAsyncSubscription(
    onSettingsWindowClosed,
    (event) => void handleSettingsWindowClosed(context, event),
    (error) => context.report("Could not observe Settings close", error),
  );
}

export function useSettingsWindowController(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<string | null>(null);
  const readySessionRef = useRef<string | null>(null);
  const activeSectionRef = useRef(loadActiveSection());
  const snapshotRevisionRef = useRef<{
    revision: number;
    value: Omit<import("./settingsDraft").SettingsDialogDraft, "activeSection"> | null;
  }>({ revision: 0, value: null });
  const requestOwnerRef = useRef(createSettingsRequestOwner());
  const previewOwnerRef = useRef(createSettingsPreviewOwner());
  const pendingShutdownRef = useRef<PendingShutdown | null>(null);

  function snapshot(overrides: Partial<SettingsWindowSnapshot> = {}): SettingsWindowSnapshot {
    const current = optionsRef.current;
    const next = {
      settings: current.settings,
      columnOrder: [...current.columnOrder],
      shortcuts: { ...current.shortcuts },
      autoLayout: current.autoLayout,
      activeSection: activeSectionRef.current,
      running: current.running,
      portError: current.portError,
      ...overrides,
    };
    const comparable = {
      settings: next.settings,
      columnOrder: next.columnOrder,
      shortcuts: next.shortcuts,
      autoLayout: next.autoLayout,
    };
    const revisionState = snapshotRevisionRef.current;
    if (revisionState.value === null || !isEqual(revisionState.value, comparable)) {
      revisionState.revision += 1;
      revisionState.value = comparable;
    }
    return { ...next, revision: revisionState.revision };
  }

  function report(message: string, error: unknown): void {
    optionsRef.current.notify("error", `${message}: ${String(error)}`);
  }

  async function clearPreview(
    sessionId: string,
    durableAppearance?: SettingsAppearance,
  ): Promise<void> {
    if (sessionRef.current !== sessionId || !requestOwnerRef.current.accepts(sessionId)) return;
    const event = previewOwnerRef.current.clear(
      durableAppearance ?? appearanceOf(optionsRef.current.getDurableSettings()),
    );
    if (!event) return;
    try {
      await broadcastSettingsPreviewCleared(event);
    } catch (error) {
      if (sessionRef.current === sessionId && requestOwnerRef.current.accepts(sessionId))
        previewOwnerRef.current.activate(sessionId);
      throw error;
    }
  }

  async function resetPreview(): Promise<void> {
    await broadcastSettingsPreviewCleared(
      createAuthoritativeSettingsPreviewReset(
        appearanceOf(optionsRef.current.getDurableSettings()),
      ),
    );
  }

  useSettingsWindowSubscriptions({
    requestOwner: requestOwnerRef.current,
    previewOwner: previewOwnerRef.current,
    pendingShutdownRef,
    readySessionRef,
    sessionRef,
    snapshot,
    handleRequest,
    clearPreview,
    resetPreview,
    report,
    clearListenerError: () => optionsRef.current.clearListenerError(),
  });

  useEffect(() => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    void sendSettingsWindowState({ sessionId, snapshot: snapshot() }).catch(() => {});
  }, [
    options.settings,
    options.columnOrder,
    options.shortcuts,
    options.autoLayout,
    options.running,
    options.portError,
  ]);

  useEffect(() => {
    if (!options.ready) return;
    void resetPreview().catch((error: unknown) =>
      report("Could not restore saved Settings appearance", error),
    );
    // Recovery is tied to authoritative startup, not ordinary settings edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.ready]);

  useEffect(
    () => () => {
      const pending = pendingShutdownRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The main window closed during Settings shutdown."));
        pendingShutdownRef.current = null;
      }
      const cleared = previewOwnerRef.current.clear(
        appearanceOf(optionsRef.current.getDurableSettings()),
      );
      if (cleared) void broadcastSettingsPreviewCleared(cleared).catch(() => {});
      else void resetPreview().catch(() => {});
      requestOwnerRef.current.deactivate();
      previewOwnerRef.current.deactivate();
      readySessionRef.current = null;
      sessionRef.current = null;
      void destroySettingsWindowFromMain().catch(() => {});
    },
    [],
  );

  async function handleRequest(request: SettingsWindowRequest): Promise<void> {
    const rejected = requestOwnerRef.current.begin(request);
    if (rejected) {
      await sendSettingsOperationResult({
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: false,
        error: rejected,
      });
      return;
    }

    let result: SettingsWindowResult;
    try {
      result = await perform(request);
    } catch (error) {
      let failedSnapshot = snapshot();
      if (request.action.kind === "save") {
        try {
          const settings = await api.getSettings();
          failedSnapshot = snapshot({ settings });
        } catch {
          /* retain the last known durable snapshot */
        }
      }
      result = {
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        snapshot: failedSnapshot,
      };
    } finally {
      requestOwnerRef.current.finish(request);
    }
    await sendSettingsOperationResult(result).catch((error: unknown) =>
      report("Could not answer Settings", error),
    );
  }

  async function perform(request: SettingsWindowRequest): Promise<SettingsWindowResult> {
    const base = { sessionId: request.sessionId, requestId: request.requestId, ok: true };
    const current = optionsRef.current;
    switch (request.action.kind) {
      case "save": {
        const authoritative = snapshot();
        if (request.action.baseline.revision > authoritative.revision) {
          return {
            ...base,
            ok: false,
            error: "Settings was based on an invalid future revision.",
            snapshot: authoritative,
            conflicts: ["revision"],
          };
        }
        const reconciliation = reconcileSettingsDraft(
          request.action.baseline.draft,
          request.action.draft,
          draftFromSnapshot(authoritative),
        );
        if (!reconciliation.ok) {
          return {
            ...base,
            ok: false,
            error: `Settings also changed in the main window: ${reconciliation.conflicts.join(", ")}. Your draft was kept open.`,
            snapshot: authoritative,
            conflicts: reconciliation.conflicts,
          };
        }
        const merged = reconciliation.draft;
        const persisted = await current.save(merged);
        activeSectionRef.current = persisted.activeSection;
        const saved = snapshot({
          settings: persisted.settings,
          columnOrder: [...persisted.columnOrder],
          shortcuts: { ...persisted.shortcuts },
          autoLayout: persisted.autoLayout,
          activeSection: persisted.activeSection,
        });
        await clearPreview(request.sessionId, appearanceOf(saved.settings));
        return { ...base, snapshot: saved };
      }
      case "getExportSections":
        await current.flush();
        return { ...base, sections: await api.getSettingsSections() };
      case "export":
        await current.flush();
        return { ...base, picked: await api.exportSettings(request.action.sections) };
      case "peekImport":
        await current.flush();
        return { ...base, sections: await api.peekSettingsImport() };
      case "applyImport": {
        await current.flush();
        const imported = await api.applySettingsImport(request.action.sections);
        const persisted = await current.applyImported(imported);
        return { ...base, snapshot: snapshot({ settings: persisted }) };
      }
      case "exportCa":
        return { ...base, picked: await api.exportCa() };
      case "regenerateCa":
        if (current.running) throw new Error("Stop the proxy before regenerating the CA.");
        await api.regenerateCa();
        current.refreshCa();
        return base;
    }
  }

  const open = useCallback(() => {
    let startedSession: string | null = null;
    void openOrFocusSettingsWindow(
      () => {
        const sessionId = crypto.randomUUID();
        startedSession = sessionId;
        sessionRef.current = sessionId;
        requestOwnerRef.current.activate(sessionId);
        previewOwnerRef.current.activate(sessionId);
        readySessionRef.current = null;
        activeSectionRef.current = loadActiveSection();
        return sessionId;
      },
      () => sessionRef.current,
      resetPreview,
    ).catch((error: unknown) => {
      if (startedSession && sessionRef.current === startedSession) {
        requestOwnerRef.current.deactivate(startedSession);
        previewOwnerRef.current.deactivate();
        readySessionRef.current = null;
        sessionRef.current = null;
      }
      report("Could not open Settings", error);
    });
  }, []);

  const closeForShutdown = useCallback(async (): Promise<void> => {
    if (!(await isSettingsWindowOpen())) return;
    const sessionId = sessionRef.current;
    if (!sessionId) {
      await destroySettingsWindowFromMain();
      await resetPreview();
      optionsRef.current.clearListenerError();
      return;
    }
    if (readySessionRef.current !== sessionId) {
      await destroySettingsWindowFromMain();
      await clearSettingsWindowOwnership(
        {
          requestOwner: requestOwnerRef.current,
          previewOwner: previewOwnerRef.current,
          pendingShutdownRef,
          readySessionRef,
          sessionRef,
          snapshot,
          handleRequest,
          clearPreview,
          resetPreview,
          report,
          clearListenerError: () => optionsRef.current.clearListenerError(),
        },
        sessionId,
      );
      return;
    }
    const active = pendingShutdownRef.current;
    if (active) throw new Error("Settings is already handling an app-close request.");
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingShutdownRef.current?.requestId !== requestId) return;
        pendingShutdownRef.current = null;
        reject(new Error("Timed out waiting for Settings to close."));
      }, 300_000);
      pendingShutdownRef.current = { sessionId, requestId, resolve, reject, timer };
      void requestSettingsShutdown({ sessionId, requestId }).catch((error: unknown) => {
        if (pendingShutdownRef.current?.requestId !== requestId) return;
        clearTimeout(timer);
        pendingShutdownRef.current = null;
        reject(new Error(`Could not ask Settings to close: ${String(error)}`));
      });
    });
  }, []);

  return { open, closeForShutdown };
}
