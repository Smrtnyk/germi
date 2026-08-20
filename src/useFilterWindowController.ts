import { useCallback, useEffect, useRef } from "react";

import {
  onFilterPreview,
  onFilterSaveRequest,
  onFilterWindowClosed,
  onFilterWindowReady,
  sendFilterSaveResult,
  sendFilterWindowState,
} from "./filterWindowEvents";
import {
  cancelPendingFilterWindowOpen,
  isFilterWindowOpenCancelled,
  openOrFocusFilterWindow,
} from "./filterWindow";
import { FilterPreviewOwner } from "./filterPreviewProtocol";
import { createFilterSaveOwner, type FilterSaveOwner } from "./filterSaveOwner";
import {
  createFilterWindowLifecycleOwner,
  type FilterSaveRequest,
  type FilterWindowClosed,
  type FilterWindowLifecycleOwner,
  type FilterWindowReady,
} from "./filterWindowProtocol";
import type { FilterPreviewMessage } from "./filterPreviewProtocol";
import type { FilterDraft, PreparedFilterDraft, SavedFilter } from "./savedFilters";
import type { Notify } from "./toast";
import { useAsyncSubscription } from "./useTauriListen";

interface Options {
  initialDraft: FilterDraft;
  existingFilters: SavedFilter[];
  filterColorPresets: string[];
  save: (filter: PreparedFilterDraft, only: boolean) => SavedFilter;
  preview: (preview: { draft: FilterDraft; only: boolean } | null) => void;
  notify: Notify;
}

function copyDraft(draft: FilterDraft): FilterDraft {
  return { ...draft, kinds: [...draft.kinds], statuses: [...draft.statuses] };
}

function copyFilters(filters: SavedFilter[]): SavedFilter[] {
  return filters.map((filter) => ({
    ...filter,
    kinds: [...filter.kinds],
    statuses: [...filter.statuses],
  }));
}

async function onOwnedFilterWindowReady(
  handler: Parameters<typeof onFilterWindowReady>[0],
): ReturnType<typeof onFilterWindowReady> {
  const unlisten = await onFilterWindowReady(handler);
  return () => {
    unlisten();
    void cancelPendingFilterWindowOpen().catch(() => {});
  };
}

function openFilterWindow(notify: Notify): void {
  void openOrFocusFilterWindow().catch((error: unknown) => {
    if (!isFilterWindowOpenCancelled(error)) {
      notify("error", `Could not open the filter window: ${String(error)}`);
    }
  });
}

interface WindowOwners {
  save: FilterSaveOwner;
  preview: FilterPreviewOwner;
  lifecycle: FilterWindowLifecycleOwner;
}

function receiveReady(
  owners: WindowOwners,
  ready: FilterWindowReady,
  initialDraft: FilterDraft,
  filters: SavedFilter[],
  presets: string[],
  applyPreview: Options["preview"],
  notify: Notify,
): void {
  const disposition = owners.lifecycle.receiveReady(ready);
  if (!disposition) return;
  const { sessionId } = ready;
  if (disposition === "activate") {
    const preview = owners.preview.activateSession(sessionId);
    if (preview !== undefined) applyPreview(preview);
    owners.save.activateSession(sessionId);
  }
  void sendFilterWindowState({
    sessionId,
    initialDraft: copyDraft(initialDraft),
    existingFilters: copyFilters(filters),
    filterColorPresets: [...presets],
  }).catch((error: unknown) =>
    notify("error", `Could not initialize the filter window: ${String(error)}`),
  );
}

function receivePreview(
  owner: FilterPreviewOwner,
  message: FilterPreviewMessage,
  applyPreview: Options["preview"],
): void {
  const preview = owner.receive(message);
  if (preview !== undefined) applyPreview(preview);
}

function receiveSave(
  owner: FilterSaveOwner,
  request: FilterSaveRequest,
  save: Options["save"],
  notify: Notify,
): void {
  const result = owner.handle(request, save);
  void sendFilterSaveResult(result).catch((error: unknown) =>
    notify("error", `Could not answer the filter window: ${String(error)}`),
  );
}

function receiveClosed(
  owners: WindowOwners,
  closed: FilterWindowClosed,
  applyPreview: Options["preview"],
): void {
  if (!owners.lifecycle.receiveClosed(closed)) return;
  owners.save.deactivateSession();
  const preview = owners.preview.deactivateSession();
  if (preview !== undefined) applyPreview(preview);
}

/** Main-window owner for the modeless filter builder. The child can request a
 * save, but only this hook validates and mutates `useSavedFilters`. */
export function useFilterWindowController(options: Options): () => void {
  const draftRef = useRef(options.initialDraft);
  const pendingDraftRef = useRef(copyDraft(options.initialDraft));
  const filtersRef = useRef(options.existingFilters);
  const presetsRef = useRef(options.filterColorPresets);
  const saveRef = useRef(options.save);
  const notifyRef = useRef(options.notify);
  const previewRef = useRef(options.preview);
  const ownersRef = useRef<WindowOwners | null>(null);
  ownersRef.current ??= {
    save: createFilterSaveOwner(),
    preview: new FilterPreviewOwner(),
    lifecycle: createFilterWindowLifecycleOwner(),
  };
  const owners = ownersRef.current;

  draftRef.current = options.initialDraft;
  filtersRef.current = options.existingFilters;
  presetsRef.current = options.filterColorPresets;
  saveRef.current = options.save;
  notifyRef.current = options.notify;
  previewRef.current = options.preview;
  owners.save.syncFilters(options.existingFilters);

  useAsyncSubscription(
    onOwnedFilterWindowReady,
    (ready) =>
      receiveReady(
        owners,
        ready,
        pendingDraftRef.current,
        filtersRef.current,
        presetsRef.current,
        previewRef.current,
        notifyRef.current,
      ),
    (error) => notifyRef.current("error", `Could not listen for the filter window: ${error}`),
  );

  useAsyncSubscription(
    onFilterPreview,
    (message) => receivePreview(owners.preview, message, previewRef.current),
    (error) => notifyRef.current("error", `Could not receive filter previews: ${error}`),
  );

  useAsyncSubscription(
    onFilterSaveRequest,
    (request) => receiveSave(owners.save, request, saveRef.current, notifyRef.current),
    (error) => notifyRef.current("error", `Could not receive filter saves: ${error}`),
  );

  useAsyncSubscription(
    onFilterWindowClosed,
    (closed) => receiveClosed(owners, closed, previewRef.current),
    (error) => notifyRef.current("error", `Could not observe the filter window: ${error}`),
  );

  useEffect(() => {
    const sessionId = owners.lifecycle.activeSession();
    if (!sessionId) return;
    void sendFilterWindowState({
      sessionId,
      existingFilters: copyFilters(options.existingFilters),
      filterColorPresets: [...options.filterColorPresets],
    }).catch(() => {});
  }, [options.existingFilters, options.filterColorPresets, owners.lifecycle]);

  return useCallback(() => {
    pendingDraftRef.current = copyDraft(draftRef.current);
    openFilterWindow(notifyRef.current);
  }, []);
}
