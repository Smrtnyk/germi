import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { FilterPreviewMessage } from "../filterPreviewProtocol";
import type {
  FilterSaveRequest,
  FilterSaveResult,
  FilterWindowRegistration,
  FilterWindowState,
} from "../filterWindowProtocol";
import { DEFAULT_FILTER_COLOR_PRESETS } from "../filterColorPresets";

const mocks = vi.hoisted(() => ({
  stateHandler: null as ((payload: FilterWindowState) => void) | null,
  resultHandler: null as ((payload: FilterSaveResult) => void) | null,
  closeHandler: null as ((event: { preventDefault: () => void }) => void) | null,
  requestState: vi.fn<(payload: FilterWindowRegistration) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  requestSave: vi.fn<(payload: FilterSaveRequest) => Promise<void>>(() => Promise.resolve()),
  sendPreview: vi.fn<(payload: FilterPreviewMessage) => Promise<void>>(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  onCloseRequested: vi.fn(),
}));

vi.mock("../filterWindow", () => ({
  closeFilterWindow: mocks.close,
  filterWindowSessionId: () => "session-current",
}));
vi.mock("../filterWindowEvents", () => ({
  onFilterWindowState: (handler: (payload: FilterWindowState) => void) => {
    mocks.stateHandler = handler;
    return Promise.resolve(() => {
      if (mocks.stateHandler === handler) mocks.stateHandler = null;
    });
  },
  onFilterSaveResult: (handler: (payload: FilterSaveResult) => void) => {
    mocks.resultHandler = handler;
    return Promise.resolve(() => {
      if (mocks.resultHandler === handler) mocks.resultHandler = null;
    });
  },
  requestFilterWindowState: mocks.requestState,
  requestFilterSave: mocks.requestSave,
  sendFilterPreview: mocks.sendPreview,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
}));

import { FilterWindow } from "./FilterWindow";

const initialDraft = {
  query: "host:api.example",
  kinds: [],
  statuses: [],
  color: "#e879f9",
  opacity: 16,
  highlight: true,
} as const;

async function renderSeededWindow() {
  const screen = await render(<FilterWindow />);
  await vi.waitFor(() => expect(mocks.requestState).toHaveBeenCalledOnce());
  const ready = mocks.requestState.mock.calls[0][0];
  mocks.stateHandler?.({
    sessionId: ready.sessionId,
    initialDraft: { ...initialDraft, kinds: [], statuses: [] },
    existingFilters: [],
    filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
  });
  await expect.element(screen.getByRole("heading", { name: "Create saved filter" })).toBeVisible();
  await vi.waitFor(() => expect(mocks.closeHandler).not.toBeNull());
  return screen;
}

describe("FilterWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockReset().mockResolvedValue();
    mocks.stateHandler = null;
    mocks.resultHandler = null;
    mocks.closeHandler = null;
    mocks.sendPreview.mockReset().mockResolvedValue();
    mocks.onCloseRequested.mockImplementation(
      (handler: (event: { preventDefault: () => void }) => void) => {
        mocks.closeHandler = handler;
        return Promise.resolve(() => {
          if (mocks.closeHandler === handler) mocks.closeHandler = null;
        });
      },
    );
  });

  it("blocks the native close request while one save is pending", async () => {
    const screen = await renderSeededWindow();

    await screen.getByRole("button", { name: "Save filter" }).click();
    await vi.waitFor(() => expect(mocks.requestSave).toHaveBeenCalledOnce());
    const request = mocks.requestSave.mock.calls[0][0] as FilterSaveRequest;
    const preventDefault = vi.fn();
    mocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.requestSave).toHaveBeenCalledOnce();

    mocks.resultHandler?.({
      sessionId: request.sessionId,
      requestId: request.requestId,
      ok: true,
    });
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.requestSave).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it("streams a revisioned draft and leaves clearing to authoritative destruction", async () => {
    const screen = await renderSeededWindow();
    await vi.waitFor(() => expect(mocks.sendPreview).toHaveBeenCalled());
    const first = mocks.sendPreview.mock.calls[0][0]!;
    expect(first).toMatchObject({
      type: "update",
      sessionId: expect.any(String),
      revision: 1,
      draft: initialDraft,
      only: false,
    });
    const previewCallsBeforeClose = mocks.sendPreview.mock.calls.length;
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.sendPreview).toHaveBeenCalledTimes(previewCallsBeforeClose);
    expect(mocks.sendPreview.mock.calls.some(([message]) => message.type === "clear")).toBe(false);
  });

  it("updates imported presets without clobbering the live draft, Only, or picker preview", async () => {
    const screen = await renderSeededWindow();
    await screen.getByLabelText("Manual query").fill("host:draft.example");
    await screen.getByRole("button", { name: "Only", exact: true }).click();
    await screen.getByRole("button", { name: "Highlight color" }).click();
    await screen.getByRole("radio", { name: /^Preset 2,/ }).click();
    await expect.element(screen.getByLabelText("Hex")).toHaveValue("#f9731647");
    expect(mocks.requestSave).not.toHaveBeenCalled();

    mocks.stateHandler?.({
      sessionId: "session-current",
      existingFilters: [],
      filterColorPresets: ["#11223380", "#445566ff", ...DEFAULT_FILTER_COLOR_PRESETS.slice(2)],
    });

    await expect
      .element(screen.getByRole("radio", { name: "Preset 1, #112233, 50% opacity" }))
      .toBeVisible();
    await expect.element(screen.getByLabelText("Hex")).toHaveValue("#f9731647");
    await expect.element(screen.getByLabelText("Manual query")).toHaveValue("host:draft.example");
    await expect
      .element(screen.getByRole("button", { name: "Only", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(mocks.requestSave).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Apply" }).click();
    expect(mocks.requestSave).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Save filter" }).click();
    await vi.waitFor(() => expect(mocks.requestSave).toHaveBeenCalledOnce());
    expect(mocks.requestSave).toHaveBeenCalledWith(
      expect.objectContaining({
        only: true,
        draft: expect.objectContaining({
          query: "host:draft.example",
          color: "#f97316",
          opacity: 28,
        }),
      }),
    );
  });

  it("keeps the connected window open and reports a native close failure", async () => {
    mocks.close.mockRejectedValueOnce(new Error("destroy denied"));
    const screen = await renderSeededWindow();
    const preventDefault = vi.fn();
    mocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not close the filter window: Error: destroy denied");
    await expect
      .element(screen.getByRole("heading", { name: "Create saved filter" }))
      .toBeVisible();
  });

  it("keeps the connected window open and reports a Cancel failure", async () => {
    mocks.close.mockRejectedValueOnce(new Error("destroy denied"));
    const screen = await renderSeededWindow();
    await screen.getByRole("button", { name: "Cancel" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not close the filter window: Error: destroy denied");
    await expect
      .element(screen.getByRole("heading", { name: "Create saved filter" }))
      .toBeVisible();
  });

  it("retries only destruction after a confirmed save and never inserts twice", async () => {
    mocks.close.mockRejectedValueOnce(new Error("destroy denied")).mockResolvedValueOnce(undefined);
    const screen = await renderSeededWindow();

    await screen.getByRole("button", { name: "Save filter" }).click();
    await vi.waitFor(() => expect(mocks.requestSave).toHaveBeenCalledOnce());
    const request = mocks.requestSave.mock.calls[0][0] as FilterSaveRequest;
    mocks.resultHandler?.({
      sessionId: request.sessionId,
      requestId: request.requestId,
      ok: true,
    });

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The filter was saved, but its window could not close: Error: destroy denied",
      );
    await expect.element(screen.getByLabelText("Manual query")).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Retry close" })).toBeVisible();
    expect(mocks.requestSave).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.sendPreview.mock.calls.some(([message]) => message.type === "clear")).toBe(false);

    await screen.getByRole("button", { name: "Retry close" }).click();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(2));
    expect(mocks.requestSave).toHaveBeenCalledOnce();
    await expect.element(screen.getByRole("button", { name: "Closing…" })).toBeDisabled();
  });
});
