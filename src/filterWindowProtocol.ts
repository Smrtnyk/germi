import type { FilterDraft, SavedFilter } from "./savedFilters";

export interface FilterWindowRegistration {
  sessionId: string;
}

export interface FilterWindowLifecycle extends FilterWindowRegistration {
  incarnation: number;
}

export type FilterWindowReady = FilterWindowLifecycle;
export type FilterWindowClosed = FilterWindowLifecycle;

export interface FilterWindowState {
  sessionId: string;
  existingFilters: SavedFilter[];
  /** Authoritative complete #rrggbbaa tints from durable Settings. */
  filterColorPresets: string[];
  initialDraft?: FilterDraft;
}

export interface FilterSaveRequest {
  sessionId: string;
  requestId: string;
  draft: FilterDraft;
  only: boolean;
}

export type FilterSaveResult =
  | { sessionId: string; requestId: string; ok: true }
  | { sessionId: string; requestId: string; ok: false; error: string; saved?: boolean };

export type FilterWindowReadyDisposition = "activate" | "refresh";

function validLifecycle(lifecycle: FilterWindowLifecycle): boolean {
  return (
    lifecycle.sessionId.length > 0 &&
    Number.isSafeInteger(lifecycle.incarnation) &&
    lifecycle.incarnation > 0
  );
}

/** Main-window arbitration for lifecycle events emitted by replaceable child
 * webviews. Incarnations are backend-owned, so delayed ready/close delivery can
 * never revive or clear a newer session. */
export interface FilterWindowLifecycleOwner {
  receiveReady: (ready: FilterWindowReady) => FilterWindowReadyDisposition | null;
  receiveClosed: (closed: FilterWindowClosed) => boolean;
  activeSession: () => string | null;
}

export function createFilterWindowLifecycleOwner(): FilterWindowLifecycleOwner {
  let latestIncarnation = 0;
  let activeSessionId: string | null = null;
  return {
    receiveReady: (ready) => {
      if (!validLifecycle(ready) || ready.incarnation < latestIncarnation) return null;
      if (ready.incarnation === latestIncarnation) {
        return activeSessionId === ready.sessionId ? "refresh" : null;
      }
      latestIncarnation = ready.incarnation;
      activeSessionId = ready.sessionId;
      return "activate";
    },
    receiveClosed: (closed) => {
      if (!validLifecycle(closed) || closed.incarnation < latestIncarnation) return false;
      if (closed.incarnation === latestIncarnation && activeSessionId !== closed.sessionId) {
        return false;
      }
      latestIncarnation = closed.incarnation;
      activeSessionId = null;
      return true;
    },
    activeSession: () => activeSessionId,
  };
}
