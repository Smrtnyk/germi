import { useCallback, useEffect, useRef, useState } from "react";
import { closeFilterWindow, filterWindowSessionId } from "../filterWindow";
import {
  onFilterSaveResult,
  onFilterWindowState,
  requestFilterSave,
  requestFilterWindowState,
  sendFilterPreview,
} from "../filterWindowEvents";
import { type FilterSaveResult, type FilterWindowState } from "../filterWindowProtocol";
import { FilterWindowSession } from "../filterWindowSession";
import { filterColorPresetParts } from "../filterColorPresets";
import type { FilterDraft } from "../savedFilters";
import { useNativeWindowCloseRequest } from "../useSafeWindowClose";
import { FilterWindowView } from "./FilterWindowView";

function ActiveFilterWindow({
  state,
  close,
  save,
  preview,
  onSavingChange,
  windowError,
}: {
  state: FilterWindowState;
  close: () => void;
  save: (draft: FilterDraft, only: boolean) => Promise<FilterSaveResult>;
  preview: (draft: FilterDraft, only: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  windowError: string | null;
}) {
  const [draft, setDraft] = useState<FilterDraft>(() => ({
    ...(state.initialDraft as FilterDraft),
    kinds: [...(state.initialDraft as FilterDraft).kinds],
    statuses: [...(state.initialDraft as FilterDraft).statuses],
  }));

  return (
    <FilterWindowView
      draft={draft}
      existingFilters={state.existingFilters}
      colorPresets={filterColorPresetParts(state.filterColorPresets)}
      windowError={windowError}
      onChange={setDraft}
      onPreviewChange={preview}
      onSave={save}
      onSavingChange={onSavingChange}
      onCancel={close}
    />
  );
}

export function FilterWindow() {
  const sessionIdRef = useRef(filterWindowSessionId());
  const sessionRef = useRef<FilterWindowSession | null>(null);
  const revisionRef = useRef(0);
  const savingRef = useRef(false);
  const savedResultRef = useRef<Extract<FilterSaveResult, { ok: true }> | null>(null);
  const [state, setState] = useState<FilterWindowState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (savingRef.current) return;
    void closeFilterWindow().catch((cause: unknown) =>
      setError(`Could not close the filter window: ${String(cause)}`),
    );
  }, []);

  const preview = useCallback((draft: FilterDraft, only: boolean) => {
    revisionRef.current++;
    void sendFilterPreview({
      type: "update",
      sessionId: sessionIdRef.current,
      revision: revisionRef.current,
      draft: { ...draft, kinds: [...draft.kinds], statuses: [...draft.statuses] },
      only,
    }).catch((cause: unknown) => setError(`Could not update the filter preview: ${String(cause)}`));
  }, []);

  useEffect(() => {
    const session = new FilterWindowSession({
      sessionId: sessionIdRef.current,
      transport: {
        onState: onFilterWindowState,
        onSaveResult: onFilterSaveResult,
        requestState: requestFilterWindowState,
        requestSave: requestFilterSave,
      },
      onState: (next) => {
        setError(null);
        setState((current) => {
          if (!current && next.initialDraft) return next;
          return current
            ? {
                ...current,
                existingFilters: next.existingFilters,
                filterColorPresets: next.filterColorPresets,
              }
            : current;
        });
      },
      onError: setError,
    });
    sessionRef.current = session;
    void session.start();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, []);

  useNativeWindowCloseRequest(close, (cause) => setError(String(cause)));

  const save = useCallback(async (draft: FilterDraft, only: boolean): Promise<FilterSaveResult> => {
    const result =
      savedResultRef.current ??
      (await (sessionRef.current?.save(draft, only) ??
        Promise.resolve({
          sessionId: sessionIdRef.current,
          requestId: "unavailable",
          ok: false as const,
          error: "The filter window is not connected to Germi.",
        })));
    if (result.ok) {
      savedResultRef.current = result;
      try {
        await closeFilterWindow();
      } catch (cause) {
        savingRef.current = false;
        return {
          sessionId: result.sessionId,
          requestId: result.requestId,
          ok: false,
          error: `The filter was saved, but its window could not close: ${String(cause)}`,
          saved: true,
        };
      }
    }
    return result;
  }, []);

  if (!state?.initialDraft) {
    return (
      <main className="filter-window filter-window-loading">
        <h1>Create saved filter</h1>
        <p className="muted">Connecting to the main Germi window…</p>
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }

  return (
    <ActiveFilterWindow
      state={state}
      close={close}
      save={save}
      preview={preview}
      onSavingChange={(saving) => {
        savingRef.current = saving;
      }}
      windowError={error}
    />
  );
}
