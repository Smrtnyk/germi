import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AcceptedSettingsPreview,
  ClearedSettingsPreview,
  SettingsPreviewRequest,
  SettingsPreviewResume,
  SettingsWindowClosed,
  SettingsWindowReady,
  SettingsWindowRequest,
  SettingsWindowResult,
  SettingsWindowShutdownRequest,
  SettingsWindowShutdownResult,
  SettingsWindowState,
} from "./settingsWindowProtocol";

const READY = "germi://settings-window-ready";
const STATE = "germi://settings-window-state";
const REQUEST = "germi://settings-window-request";
const RESULT = "germi://settings-window-result";
const SHUTDOWN_REQUEST = "germi://settings-window-shutdown-request";
const SHUTDOWN_RESULT = "germi://settings-window-shutdown-result";
const SETTINGS_WINDOW_CLOSED = "germi://settings-window-closed";
const PREVIEW_REQUEST = "germi://settings-preview-request";
const PREVIEW_RESUME = "germi://settings-preview-resume";
export const PREVIEW_ACCEPTED = "germi://settings-preview-accepted";
export const PREVIEW_CLEARED = "germi://settings-preview-cleared";
const THEME_SYNC_READY = "germi://theme-sync-ready";

function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, ({ payload }) => handler(payload));
}

export const announceSettingsWindowReady = (payload: SettingsWindowReady) => emit(READY, payload);
export const onSettingsWindowReady = (handler: (payload: SettingsWindowReady) => void) =>
  on(READY, handler);
export const sendSettingsWindowState = (payload: SettingsWindowState) => emit(STATE, payload);
export const onSettingsWindowState = (handler: (payload: SettingsWindowState) => void) =>
  on(STATE, handler);
export const requestSettingsOperation = (payload: SettingsWindowRequest) => emit(REQUEST, payload);
export const onSettingsOperation = (handler: (payload: SettingsWindowRequest) => void) =>
  on(REQUEST, handler);
export const sendSettingsOperationResult = (payload: SettingsWindowResult) => emit(RESULT, payload);
export const onSettingsOperationResult = (handler: (payload: SettingsWindowResult) => void) =>
  on(RESULT, handler);
export const requestSettingsShutdown = (payload: SettingsWindowShutdownRequest) =>
  emit(SHUTDOWN_REQUEST, payload);
export const onSettingsShutdownRequest = (
  handler: (payload: SettingsWindowShutdownRequest) => void,
) => on(SHUTDOWN_REQUEST, handler);
export const sendSettingsShutdownResult = (payload: SettingsWindowShutdownResult) =>
  emit(SHUTDOWN_RESULT, payload);
export const onSettingsShutdownResult = (
  handler: (payload: SettingsWindowShutdownResult) => void,
) => on(SHUTDOWN_RESULT, handler);
export const onSettingsWindowClosed = (handler: (payload: SettingsWindowClosed) => void) =>
  on(SETTINGS_WINDOW_CLOSED, handler);
export const requestSettingsPreview = (payload: SettingsPreviewRequest) =>
  emit(PREVIEW_REQUEST, payload);
export const onSettingsPreviewRequest = (handler: (payload: SettingsPreviewRequest) => void) =>
  on(PREVIEW_REQUEST, handler);
export const requestSettingsPreviewResume = (payload: SettingsPreviewResume) =>
  emit(PREVIEW_RESUME, payload);
export const onSettingsPreviewResume = (handler: (payload: SettingsPreviewResume) => void) =>
  on(PREVIEW_RESUME, handler);
export const broadcastSettingsPreview = (payload: AcceptedSettingsPreview) =>
  emit(PREVIEW_ACCEPTED, payload);
export const broadcastSettingsPreviewCleared = (payload: ClearedSettingsPreview) =>
  emit(PREVIEW_CLEARED, payload);
export const announceThemeSyncReady = () => emit(THEME_SYNC_READY, null);
export const onThemeSyncReady = (handler: () => void) => on<null>(THEME_SYNC_READY, handler);
