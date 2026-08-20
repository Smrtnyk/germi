import { useEffect, useMemo, useRef, useState } from "react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { FilterPreviewMessage } from "./filterPreviewProtocol";
import { DEFAULT_FILTER_COLOR_PRESETS } from "./filterColorPresets";
import type {
  FilterSaveRequest,
  FilterSaveResult,
  FilterWindowClosed,
  FilterWindowReady,
  FilterWindowState,
} from "./filterWindowProtocol";
import {
  DEFAULT_FILTER_OPACITY,
  type FilterDraft,
  type PreparedFilterDraft,
  type SavedFilter,
} from "./savedFilters";
import {
  assignBinding,
  DEFAULT_SHORTCUTS,
  dispatchShortcutCommand,
  reverseLookup,
  SHORTCUT_COMMANDS,
  type CommandId,
} from "./shortcuts";
import { useFilterWindowController } from "./useFilterWindowController";

const mocks = vi.hoisted(() => ({
  ready: null as ((payload: FilterWindowReady) => void) | null,
  saveRequest: null as ((payload: FilterSaveRequest) => void) | null,
  previewEvent: null as ((payload: FilterPreviewMessage) => void) | null,
  closed: null as ((payload: FilterWindowClosed) => void) | null,
  open: vi.fn<() => Promise<"created" | "focused">>(),
  cancelOpen: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  sendState: vi.fn<(payload: FilterWindowState) => Promise<void>>(() => Promise.resolve()),
  sendResult: vi.fn<(payload: FilterSaveResult) => Promise<void>>(() => Promise.resolve()),
  onReady: vi.fn(),
  onSaveRequest: vi.fn(),
  onPreview: vi.fn(),
  onClosed: vi.fn(),
}));

vi.mock("./filterWindow", () => ({
  openOrFocusFilterWindow: mocks.open,
  cancelPendingFilterWindowOpen: mocks.cancelOpen,
  isFilterWindowOpenCancelled: () => false,
}));
vi.mock("./filterWindowEvents", () => ({
  onFilterWindowReady: mocks.onReady,
  onFilterSaveRequest: mocks.onSaveRequest,
  onFilterPreview: mocks.onPreview,
  onFilterWindowClosed: mocks.onClosed,
  sendFilterWindowState: mocks.sendState,
  sendFilterSaveResult: mocks.sendResult,
}));

const initialDraft: FilterDraft = {
  query: "host:initial.example",
  kinds: ["doc"],
  statuses: [],
  color: "#e879f9",
  opacity: DEFAULT_FILTER_OPACITY,
  highlight: true,
};

function saved(overrides: Partial<SavedFilter> = {}): SavedFilter {
  return {
    id: "saved-1",
    query: "status:5xx",
    kinds: [],
    statuses: [],
    color: "#fbbf24",
    opacity: DEFAULT_FILTER_OPACITY,
    highlight: true,
    ...overrides,
  };
}

function Harness({
  onFocus,
  onSaved,
  onPreview = () => {},
}: {
  onFocus: () => void;
  onSaved: (only: boolean) => void;
  onPreview?: (preview: { draft: FilterDraft; only: boolean } | null) => void;
}) {
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialDraft.query);
  const [filters, setFilters] = useState<SavedFilter[]>([saved()]);
  const [presets, setPresets] = useState([...DEFAULT_FILTER_COLOR_PRESETS]);
  const draft = { ...initialDraft, query };
  const open = useFilterWindowController({
    initialDraft: draft,
    existingFilters: filters,
    filterColorPresets: presets,
    save: (filter: PreparedFilterDraft, only: boolean) => {
      const created = { id: "created", ...filter };
      setFilters((current) => [...current, created]);
      onSaved(only);
      return created;
    },
    preview: onPreview,
    notify: vi.fn(),
  });
  const reverse = useMemo(() => {
    const assigned = assignBinding(DEFAULT_SHORTCUTS, "create-filter", "Mod+F");
    if (!assigned.ok) throw new Error("unexpected reserved binding");
    return reverseLookup(assigned.bindings);
  }, []);

  useEffect(() => {
    const actions = Object.fromEntries(SHORTCUT_COMMANDS.map(({ id }) => [id, () => {}])) as Record<
      CommandId,
      () => void
    >;
    actions["focus-filter"] = onFocus;
    actions["create-filter"] = open;
    const handler = (event: KeyboardEvent) => {
      dispatchShortcutCommand(reverse, event, actions, {
        editing: event.target instanceof HTMLInputElement,
        fromFilterInput: event.target === filterRef.current,
        modalOpen: false,
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onFocus, open, reverse]);

  return (
    <>
      <input
        ref={filterRef}
        aria-label="Top filter"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <button onClick={() => setFilters((current) => [...current, saved({ id: "external" })])}>
        Add external filter
      </button>
      <button
        onClick={() =>
          setPresets(["#11223380", "#445566ff", ...DEFAULT_FILTER_COLOR_PRESETS.slice(2)])
        }
      >
        Import preset colors
      </button>
    </>
  );
}

function installEventMocks() {
  mocks.onReady.mockImplementation((handler: (payload: FilterWindowReady) => void) => {
    mocks.ready = handler;
    return Promise.resolve(() => {
      if (mocks.ready === handler) mocks.ready = null;
    });
  });
  mocks.onSaveRequest.mockImplementation((handler: (payload: FilterSaveRequest) => void) => {
    mocks.saveRequest = handler;
    return Promise.resolve(() => {
      if (mocks.saveRequest === handler) mocks.saveRequest = null;
    });
  });
  mocks.onPreview.mockImplementation((handler: (payload: FilterPreviewMessage) => void) => {
    mocks.previewEvent = handler;
    return Promise.resolve(() => {
      if (mocks.previewEvent === handler) mocks.previewEvent = null;
    });
  });
  mocks.onClosed.mockImplementation((handler: (payload: FilterWindowClosed) => void) => {
    mocks.closed = handler;
    return Promise.resolve(() => {
      if (mocks.closed === handler) mocks.closed = null;
    });
  });
}

describe("useFilterWindowController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ready = null;
    mocks.saveRequest = null;
    mocks.previewEvent = null;
    mocks.closed = null;
    mocks.open.mockResolvedValueOnce("created").mockResolvedValue("focused");
    installEventMocks();
  });

  it("opens once per focused-top-filter chord and reuses the singleton", async () => {
    const onFocus = vi.fn();
    const screen = await render(<Harness onFocus={onFocus} onSaved={vi.fn()} />);
    await screen.getByLabelText("Top filter").click();
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(onFocus).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("cancels an in-flight native open when the main controller disposes", async () => {
    const screen = await render(<Harness onFocus={vi.fn()} onSaved={vi.fn()} />);

    await screen.unmount();

    expect(mocks.cancelOpen).toHaveBeenCalledOnce();
  });

  it("seeds the current draft and updates filters without reseeding draft edits", async () => {
    const screen = await render(<Harness onFocus={vi.fn()} onSaved={vi.fn()} />);
    await vi.waitFor(() => expect(mocks.ready).not.toBeNull());
    await screen.getByLabelText("Top filter").fill("host:current.example");
    await userEvent.keyboard("{Control>}f{/Control}");
    mocks.ready?.({ sessionId: "session-1", incarnation: 1 });
    await vi.waitFor(() => expect(mocks.sendState).toHaveBeenCalled());
    expect(mocks.sendState).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      initialDraft: { ...initialDraft, query: "host:current.example" },
      existingFilters: [saved()],
      filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
    });
    await screen.getByRole("button", { name: "Add external filter" }).click();
    await vi.waitFor(() => expect(mocks.sendState).toHaveBeenCalledTimes(2));
    expect(mocks.sendState).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      existingFilters: [saved(), saved({ id: "external" })],
      filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
    });
  });

  it("broadcasts saved or imported presets to an active child without reseeding its draft", async () => {
    const screen = await render(<Harness onFocus={vi.fn()} onSaved={vi.fn()} />);
    await vi.waitFor(() => expect(mocks.ready).not.toBeNull());
    await screen.getByLabelText("Top filter").fill("host:draft.example");
    await userEvent.keyboard("{Control>}f{/Control}");
    mocks.ready?.({ sessionId: "session-presets", incarnation: 1 });
    await vi.waitFor(() => expect(mocks.sendState).toHaveBeenCalled());
    mocks.sendState.mockClear();

    await screen.getByRole("button", { name: "Import preset colors" }).click();

    await vi.waitFor(() => expect(mocks.sendState).toHaveBeenCalledOnce());
    expect(mocks.sendState).toHaveBeenLastCalledWith({
      sessionId: "session-presets",
      existingFilters: [saved()],
      filterColorPresets: ["#11223380", "#445566ff", ...DEFAULT_FILTER_COLOR_PRESETS.slice(2)],
    });
    expect(mocks.sendState.mock.calls[0]?.[0]).not.toHaveProperty("initialDraft");
  });

  it("saves once, replays duplicate acknowledgements, and rejects stale or changed retries", async () => {
    const onSaved = vi.fn();
    await render(<Harness onFocus={vi.fn()} onSaved={onSaved} />);
    await vi.waitFor(() => expect(mocks.ready).not.toBeNull());
    await vi.waitFor(() => expect(mocks.saveRequest).not.toBeNull());
    mocks.ready?.({ sessionId: "session-1", incarnation: 1 });
    const draft = { ...initialDraft, query: "host:new.example" };
    mocks.saveRequest?.({ sessionId: "session-1", requestId: "request-1", draft, only: true });
    mocks.saveRequest?.({ sessionId: "session-1", requestId: "request-1", draft, only: true });
    mocks.saveRequest?.({ sessionId: "stale", requestId: "request-2", draft, only: false });
    mocks.saveRequest?.({ sessionId: "session-1", requestId: "request-3", draft, only: false });
    await vi.waitFor(() => expect(mocks.sendResult).toHaveBeenCalledTimes(4));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(true);
    expect(mocks.sendResult.mock.calls.map(([payload]) => payload)).toEqual([
      { sessionId: "session-1", requestId: "request-1", ok: true },
      { sessionId: "session-1", requestId: "request-1", ok: true },
      expect.objectContaining({ requestId: "request-2", ok: false }),
      expect.objectContaining({ requestId: "request-3", ok: false, saved: true }),
    ]);
  });

  it("clears previews only on replacement or authoritative close while rejecting late events", async () => {
    const onPreview = vi.fn();
    await render(<Harness onFocus={vi.fn()} onSaved={vi.fn()} onPreview={onPreview} />);
    await vi.waitFor(() => expect(mocks.ready).not.toBeNull());
    await vi.waitFor(() => expect(mocks.previewEvent).not.toBeNull());
    await vi.waitFor(() => expect(mocks.closed).not.toBeNull());

    mocks.ready?.({ sessionId: "session-1", incarnation: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-1",
      revision: 1,
      draft: { ...initialDraft, query: "content:first" },
      only: true,
    });
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        only: true,
        draft: expect.objectContaining({ query: "content:first" }),
      }),
    );

    mocks.ready?.({ sessionId: "session-2", incarnation: 2 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    const callsAfterReplacement = onPreview.mock.calls.length;
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-1",
      revision: 99,
      draft: { ...initialDraft, query: "content:stale" },
      only: true,
    });
    expect(onPreview).toHaveBeenCalledTimes(callsAfterReplacement);

    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-2",
      revision: 1,
      draft: { ...initialDraft, query: "content:second" },
      only: false,
    });
    const previewCallsBeforeDelayedLifecycle = onPreview.mock.calls.length;
    const stateCallsBeforeDelayedReady = mocks.sendState.mock.calls.length;
    mocks.closed?.({ sessionId: "session-1", incarnation: 1 });
    mocks.ready?.({ sessionId: "session-1", incarnation: 1 });
    expect(onPreview).toHaveBeenCalledTimes(previewCallsBeforeDelayedLifecycle);
    expect(mocks.sendState).toHaveBeenCalledTimes(stateCallsBeforeDelayedReady);

    mocks.ready?.({ sessionId: "session-2", incarnation: 2 });
    expect(mocks.sendState).toHaveBeenCalledTimes(stateCallsBeforeDelayedReady + 1);
    expect(onPreview).toHaveBeenCalledTimes(previewCallsBeforeDelayedLifecycle);
    mocks.closed?.({ sessionId: "session-2", incarnation: 2 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    const callsAfterCrash = onPreview.mock.calls.length;
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-2",
      revision: 2,
      draft: { ...initialDraft, query: "content:late" },
      only: true,
    });
    expect(onPreview).toHaveBeenCalledTimes(callsAfterCrash);

    mocks.ready?.({ sessionId: "session-3", incarnation: 3 });
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-3",
      revision: 1,
      draft: { ...initialDraft, query: "content:saved" },
      only: true,
    });
    const previewCallsBeforeOldClose = onPreview.mock.calls.length;
    mocks.closed?.({ sessionId: "session-2", incarnation: 2 });
    expect(onPreview).toHaveBeenCalledTimes(previewCallsBeforeOldClose);
    mocks.saveRequest?.({
      sessionId: "session-3",
      requestId: "request-3",
      draft: { ...initialDraft, query: "content:saved" },
      only: true,
    });
    await vi.waitFor(() =>
      expect(mocks.sendResult).toHaveBeenLastCalledWith({
        sessionId: "session-3",
        requestId: "request-3",
        ok: true,
      }),
    );
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        only: true,
        draft: expect.objectContaining({ query: "content:saved" }),
      }),
    );
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-3",
      revision: 2,
      draft: { ...initialDraft, query: "content:still-connected" },
      only: false,
    });
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        only: false,
        draft: expect.objectContaining({ query: "content:still-connected" }),
      }),
    );

    mocks.closed?.({ sessionId: "session-3", incarnation: 3 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    const callsAfterClose = onPreview.mock.calls.length;
    mocks.previewEvent?.({
      type: "update",
      sessionId: "session-3",
      revision: 3,
      draft: { ...initialDraft, query: "content:resurrect" },
      only: true,
    });
    expect(onPreview).toHaveBeenCalledTimes(callsAfterClose);
  });
});
