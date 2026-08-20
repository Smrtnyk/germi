import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FilterPreviewMessage } from "./filterPreviewProtocol";
import type {
  FilterSaveRequest,
  FilterSaveResult,
  FilterWindowClosed,
  FilterWindowRegistration,
  FilterWindowReady,
  FilterWindowState,
} from "./filterWindowProtocol";

const READY = "germi://filter-window-ready";
const STATE = "germi://filter-window-state";
const SAVE_REQUEST = "germi://filter-window-save-request";
const SAVE_RESULT = "germi://filter-window-save-result";
const PREVIEW = "germi://filter-window-preview";
const CLOSED = "germi://filter-window-closed";

export async function requestFilterWindowState(
  registration: FilterWindowRegistration,
): Promise<void> {
  const ready = await invoke<FilterWindowReady>("register_filter_window_session", {
    sessionId: registration.sessionId,
  });
  await emit(READY, ready);
}

export function onFilterWindowReady(
  handler: (payload: FilterWindowReady) => void,
): Promise<UnlistenFn> {
  return listen<FilterWindowReady>(READY, (event) => handler(event.payload));
}

export function sendFilterWindowState(payload: FilterWindowState): Promise<void> {
  return emit(STATE, payload);
}

export function onFilterWindowState(
  handler: (payload: FilterWindowState) => void,
): Promise<UnlistenFn> {
  return listen<FilterWindowState>(STATE, (event) => handler(event.payload));
}

export function requestFilterSave(payload: FilterSaveRequest): Promise<void> {
  return emit(SAVE_REQUEST, payload);
}

export function onFilterSaveRequest(
  handler: (payload: FilterSaveRequest) => void,
): Promise<UnlistenFn> {
  return listen<FilterSaveRequest>(SAVE_REQUEST, (event) => handler(event.payload));
}

export function sendFilterSaveResult(payload: FilterSaveResult): Promise<void> {
  return emit(SAVE_RESULT, payload);
}

export function onFilterSaveResult(
  handler: (payload: FilterSaveResult) => void,
): Promise<UnlistenFn> {
  return listen<FilterSaveResult>(SAVE_RESULT, (event) => handler(event.payload));
}

export function sendFilterPreview(payload: FilterPreviewMessage): Promise<void> {
  return emit(PREVIEW, payload);
}

export function onFilterPreview(
  handler: (payload: FilterPreviewMessage) => void,
): Promise<UnlistenFn> {
  return listen<FilterPreviewMessage>(PREVIEW, (event) => handler(event.payload));
}

export function onFilterWindowClosed(
  handler: (payload: FilterWindowClosed) => void,
): Promise<UnlistenFn> {
  return listen<FilterWindowClosed>(CLOSED, (event) => handler(event.payload));
}
