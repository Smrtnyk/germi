import type { AutoLayout } from "./appState";
import type { SettingsSaveBaseline } from "./settingsReconciliation";
import type { SettingsDialogDraft } from "./settingsDraft";
import type { Bindings } from "./shortcuts";
import type { ProxySettings, SettingsSectionSummary, ThemePreference } from "./types";

export interface SettingsWindowSnapshot {
  revision: number;
  settings: ProxySettings;
  columnOrder: string[];
  shortcuts: Bindings;
  autoLayout: AutoLayout;
  activeSection: string;
  running: boolean;
  portError: string | null;
}

export interface SettingsWindowReady {
  sessionId: string;
}

export interface SettingsWindowState {
  sessionId: string;
  snapshot: SettingsWindowSnapshot;
}

export type SettingsWindowAction =
  | { kind: "save"; baseline: SettingsSaveBaseline; draft: SettingsDialogDraft }
  | { kind: "getExportSections" }
  | { kind: "export"; sections: string[] }
  | { kind: "peekImport" }
  | { kind: "applyImport"; sections: string[] }
  | { kind: "exportCa" }
  | { kind: "regenerateCa" };

export interface SettingsWindowRequest {
  sessionId: string;
  requestId: string;
  action: SettingsWindowAction;
}

export interface SettingsWindowResult {
  sessionId: string;
  requestId: string;
  ok: boolean;
  error?: string;
  snapshot?: SettingsWindowSnapshot;
  sections?: SettingsSectionSummary[] | null;
  picked?: boolean;
  conflicts?: string[];
}

export interface SettingsWindowShutdownRequest {
  sessionId: string;
  requestId: string;
}

export interface SettingsWindowShutdownResult extends SettingsWindowShutdownRequest {
  ok: boolean;
  error?: string;
}

export interface SettingsWindowClosed {
  /** Rust observes the actual webview destruction but cannot recover the
   * query-string session. JavaScript never predicts successful destruction. */
  sessionId: null;
}

export interface SettingsAppearance {
  theme: ThemePreference;
  highlightColors: Record<string, string>;
}

export interface SettingsPreviewRequest {
  sessionId: string;
  revision: number;
  appearance: SettingsAppearance;
}

export interface SettingsPreviewResume {
  sessionId: string;
}

export interface AcceptedSettingsPreview extends SettingsPreviewRequest {
  epoch: number;
}

export interface ClearedSettingsPreview {
  /** null identifies a main-owned recovery reset rather than a child session. */
  sessionId: string | null;
  epoch: number;
  revision: number;
  durableAppearance: SettingsAppearance;
}

export interface SettingsRequestOwner {
  activate: (sessionId: string) => void;
  deactivate: (sessionId?: string) => void;
  accepts: (sessionId: string) => boolean;
  idle: () => boolean;
  begin: (request: SettingsWindowRequest) => string | null;
  finish: (request: SettingsWindowRequest) => void;
}

/** Pure main-window request gate. It marks an id before async work starts, so
 * duplicate events and a second mutation cannot slip through while React is
 * waiting for the first operation to settle. */
export function createSettingsRequestOwner(): SettingsRequestOwner {
  let sessionId: string | null = null;
  const handled = new Set<string>();
  let pending = false;

  const accepts = (candidate: string) => candidate === sessionId;
  return {
    activate(nextSessionId) {
      sessionId = nextSessionId;
      handled.clear();
      pending = false;
    },
    deactivate(candidate) {
      if (candidate !== undefined && candidate !== sessionId) return;
      sessionId = null;
      handled.clear();
      pending = false;
    },
    accepts,
    idle: () => !pending,
    begin(request) {
      if (!accepts(request.sessionId)) return "This Settings window is no longer current.";
      if (handled.has(request.requestId)) return "This Settings request was already handled.";
      handled.add(request.requestId);
      if (pending) return "Another Settings operation is already in progress.";
      pending = true;
      return null;
    },
    finish(request) {
      if (accepts(request.sessionId)) pending = false;
    },
  };
}

const PREVIEW_EPOCH_KEY = "germi.settingsPreviewEpoch";
let nextPreviewEpoch = Date.now() * 1000;

function allocatePreviewEpoch(): number {
  let stored = 0;
  try {
    const parsed = Number(localStorage.getItem(PREVIEW_EPOCH_KEY));
    if (Number.isSafeInteger(parsed) && parsed >= 0) stored = parsed;
  } catch {
    // Tests and non-DOM consumers do not necessarily expose localStorage.
  }
  nextPreviewEpoch = Math.max(nextPreviewEpoch + 1, Date.now() * 1000, stored + 1);
  try {
    localStorage.setItem(PREVIEW_EPOCH_KEY, String(nextPreviewEpoch));
  } catch {
    // The in-memory monotonic epoch still protects this JavaScript lifetime.
  }
  return nextPreviewEpoch;
}

/** Create a main-owned durable reapply that is newer than any preview epoch
 * allocated before a main-webview reload in the shared origin. */
export function createAuthoritativeSettingsPreviewReset(
  durableAppearance: SettingsAppearance,
): ClearedSettingsPreview {
  return {
    sessionId: null,
    epoch: allocatePreviewEpoch(),
    revision: 0,
    durableAppearance: {
      theme: durableAppearance.theme,
      highlightColors: { ...durableAppearance.highlightColors },
    },
  };
}

export interface SettingsPreviewOwner {
  activate: (sessionId: string) => void;
  accept: (request: SettingsPreviewRequest) => AcceptedSettingsPreview | null;
  current: () => AcceptedSettingsPreview | null;
  clear: (durableAppearance: SettingsAppearance) => ClearedSettingsPreview | null;
  deactivate: () => void;
}

/** Main-owned live-preview gate. Child revisions reject replayed/out-of-order
 * requests; the owner epoch lets every webview reject events from an older
 * Settings session. */
export function createSettingsPreviewOwner(): SettingsPreviewOwner {
  let sessionId: string | null = null;
  let epoch = 0;
  let childRevision = -1;
  let broadcastRevision = 0;
  let appearance: SettingsAppearance | null = null;
  let terminal = true;

  return {
    activate(nextSessionId) {
      sessionId = nextSessionId;
      epoch = allocatePreviewEpoch();
      childRevision = -1;
      broadcastRevision = 0;
      appearance = null;
      terminal = false;
    },
    accept(request) {
      if (terminal || request.sessionId !== sessionId || request.revision <= childRevision)
        return null;
      childRevision = request.revision;
      appearance = {
        theme: request.appearance.theme,
        highlightColors: { ...request.appearance.highlightColors },
      };
      return {
        ...request,
        appearance: {
          theme: request.appearance.theme,
          highlightColors: { ...request.appearance.highlightColors },
        },
        epoch,
        revision: ++broadcastRevision,
      };
    },
    current() {
      if (terminal || !sessionId || !appearance) return null;
      return {
        sessionId,
        epoch,
        revision: broadcastRevision,
        appearance: {
          theme: appearance.theme,
          highlightColors: { ...appearance.highlightColors },
        },
      };
    },
    clear(durableAppearance) {
      if (!sessionId || terminal) return null;
      // Close the acceptance gate before any caller awaits the broadcast. A
      // late child request from this exact session can never resurrect preview.
      terminal = true;
      const event = {
        sessionId,
        epoch,
        revision: ++broadcastRevision,
        durableAppearance: {
          theme: durableAppearance.theme,
          highlightColors: { ...durableAppearance.highlightColors },
        },
      };
      appearance = null;
      return event;
    },
    deactivate() {
      terminal = true;
      sessionId = null;
      appearance = null;
    },
  };
}
