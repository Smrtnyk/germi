import {
  normalizeFilterOpacity,
  prepareFilterDraft,
  type PreparedFilterDraft,
  type SavedFilter,
} from "./savedFilters";
import type { FilterSaveRequest, FilterSaveResult } from "./filterWindowProtocol";

function failed(request: FilterSaveRequest, error: string): FilterSaveResult {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    ok: false,
    error,
  };
}

export function createFilterSaveOwner() {
  let activeSessionId: string | null = null;
  let handledResults = new Map<string, FilterSaveResult>();
  let savedRequestKey: string | null = null;
  let filters: SavedFilter[] = [];

  function requestKey(request: FilterSaveRequest): string {
    return JSON.stringify([
      request.draft.query.trim(),
      [...request.draft.kinds].sort(),
      [...request.draft.statuses].sort(),
      request.draft.color.toLowerCase(),
      normalizeFilterOpacity(request.draft.opacity),
      request.draft.highlight,
      request.only,
    ]);
  }

  function syncFilters(nextFilters: SavedFilter[]): void {
    filters = nextFilters;
  }

  function activateSession(sessionId: string): void {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    handledResults.clear();
    savedRequestKey = null;
  }

  function deactivateSession(sessionId?: string): void {
    if (sessionId !== undefined && sessionId !== activeSessionId) return;
    activeSessionId = null;
    handledResults.clear();
    savedRequestKey = null;
  }

  function handle(
    request: FilterSaveRequest,
    save: (filter: PreparedFilterDraft, only: boolean) => SavedFilter,
  ): FilterSaveResult {
    if (request.sessionId !== activeSessionId) {
      return failed(request, "This filter window is no longer current. Reopen it and try again.");
    }
    const handled = handledResults.get(request.requestId);
    if (handled) return handled;

    const key = requestKey(request);
    if (savedRequestKey !== null) {
      const result: FilterSaveResult =
        savedRequestKey === key
          ? { sessionId: request.sessionId, requestId: request.requestId, ok: true }
          : {
              sessionId: request.sessionId,
              requestId: request.requestId,
              ok: false,
              error: "This window already saved its filter. Close and reopen it.",
              saved: true,
            };
      handledResults.set(request.requestId, result);
      return result;
    }

    const prepared = prepareFilterDraft(request.draft, filters);
    if (!prepared.ok) {
      const result = failed(request, prepared.error);
      handledResults.set(request.requestId, result);
      return result;
    }

    try {
      const created = save(prepared.filter, request.only);
      filters = [...filters, created];
      savedRequestKey = key;
      const result = {
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: true,
      } as const;
      handledResults.set(request.requestId, result);
      return result;
    } catch (error) {
      const result = failed(request, `Could not save the filter: ${String(error)}`);
      handledResults.set(request.requestId, result);
      return result;
    }
  }

  return { syncFilters, activateSession, deactivateSession, handle };
}

export type FilterSaveOwner = ReturnType<typeof createFilterSaveOwner>;
