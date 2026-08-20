import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_SHORTCUTS } from "../shortcuts";
import { DEFAULT_FILTER_COLOR_PRESETS } from "../filterColorPresets";
import type {
  SettingsWindowResult,
  SettingsWindowSnapshot,
  SettingsWindowState,
} from "../settingsWindowProtocol";

const eventMocks = vi.hoisted(() => ({
  stateHandler: null as null | ((state: SettingsWindowState) => void),
  resultHandler: null as null | ((result: SettingsWindowResult) => void),
  shutdownHandler: null as null | ((request: { sessionId: string; requestId: string }) => void),
  onState: vi.fn(),
  onResult: vi.fn(),
  onShutdown: vi.fn((handler: (request: { sessionId: string; requestId: string }) => void) => {
    eventMocks.shutdownHandler = handler;
    return Promise.resolve(() => {});
  }),
  announceReady: vi.fn(() => Promise.resolve()),
  request: vi.fn((_request: unknown) => Promise.resolve()),
  requestPreview: vi.fn((_payload: unknown) => Promise.resolve()),
  resumePreview: vi.fn(() => Promise.resolve()),
  sendShutdown: vi.fn(() => Promise.resolve()),
}));

const windowMocks = vi.hoisted(() => ({
  closeHandler: null as null | ((event: { preventDefault: () => void }) => void),
  setFocus: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}));

vi.mock("../settingsWindowEvents", () => ({
  onSettingsWindowState: eventMocks.onState,
  onSettingsOperationResult: eventMocks.onResult,
  onSettingsShutdownRequest: eventMocks.onShutdown,
  announceSettingsWindowReady: eventMocks.announceReady,
  requestSettingsOperation: eventMocks.request,
  requestSettingsPreview: eventMocks.requestPreview,
  requestSettingsPreviewResume: eventMocks.resumePreview,
  sendSettingsShutdownResult: eventMocks.sendShutdown,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFocus: windowMocks.setFocus,
    onCloseRequested: vi.fn((handler) => {
      windowMocks.closeHandler = handler;
      return Promise.resolve(() => {});
    }),
  }),
}));

vi.mock("../settingsWindow", () => ({
  closeSettingsWindow: windowMocks.close,
}));

import { SettingsWindow } from "./SettingsWindow";

function snapshot(
  revision: number,
  port: number,
  settingsOverrides: Partial<SettingsWindowSnapshot["settings"]> = {},
): SettingsWindowSnapshot {
  return {
    revision,
    settings: {
      excludedHosts: [],
      headerColumns: [],
      port,
      allowRemote: false,
      maxFlows: 5000,
      captureFilter: [],
      autoStartOnLaunch: true,
      responseDelayMs: 0,
      systemProxyHotkey: "",
      theme: "dark",
      highlightColors: {},
      filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
      ...settingsOverrides,
    },
    columnOrder: ["seq", "method"],
    shortcuts: DEFAULT_SHORTCUTS,
    autoLayout: "side",
    activeSection: "connections",
    running: false,
    portError: null,
  };
}

describe("unseeded Settings window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventMocks.stateHandler = null;
    eventMocks.resultHandler = null;
    eventMocks.shutdownHandler = null;
    eventMocks.onState.mockRejectedValue(new Error("state listener failed"));
    eventMocks.onResult.mockResolvedValue(() => {});
    windowMocks.closeHandler = null;
    windowMocks.close.mockResolvedValue(undefined);
  });

  it("shows a direct Close action after handshake failure", async () => {
    const screen = await render(<SettingsWindow sessionId="failed-session" />);
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain("state listener failed"),
    );

    await screen.getByRole("button", { name: "Close Settings" }).click();

    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());
    expect(eventMocks.sendShutdown).not.toHaveBeenCalled();
  });

  it("keeps a conflicting draft open after applying the authoritative readback", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    eventMocks.onResult.mockImplementationOnce((handler) => {
      eventMocks.resultHandler = handler;
      return Promise.resolve(() => {});
    });
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });
    await expect.element(screen.getByRole("spinbutton")).toBeVisible();
    await screen.getByRole("spinbutton").fill("9090");
    await screen.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => expect(eventMocks.request).toHaveBeenCalledOnce());
    const request = eventMocks.request.mock.calls[0][0] as {
      requestId: string;
    };
    eventMocks.resultHandler?.({
      sessionId: "active-session",
      requestId: request.requestId,
      ok: false,
      error: "Settings also changed in the main window: settings.port. Your draft was kept open.",
      conflicts: ["settings.port"],
      snapshot: snapshot(2, 7070),
    });

    await expect.element(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain("draft was kept open"),
    );
    expect(windowMocks.close).not.toHaveBeenCalled();
  });

  it("sends a preset edit through detached Save without appearance previewing it", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    eventMocks.onResult.mockImplementationOnce((handler) => {
      eventMocks.resultHandler = handler;
      return Promise.resolve(() => {});
    });
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });
    await screen.getByRole("button", { name: "Appearance" }).click();
    await screen.getByRole("button", { name: "Filter preset 1 color" }).click();
    await screen.getByLabelText("Hex").fill("#11223380");
    await screen.getByRole("button", { name: "Apply" }).click();

    expect(eventMocks.requestPreview).not.toHaveBeenCalled();
    expect(eventMocks.request).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => expect(eventMocks.request).toHaveBeenCalledOnce());
    const request = eventMocks.request.mock.calls[0][0] as {
      requestId: string;
      action: {
        kind: string;
        draft: { settings: SettingsWindowSnapshot["settings"] };
      };
    };
    expect(request.action.kind).toBe("save");
    expect(request.action.draft.settings.filterColorPresets[0]).toBe("#11223380");

    eventMocks.resultHandler?.({
      sessionId: "active-session",
      requestId: request.requestId,
      ok: true,
      snapshot: snapshot(2, 8080, {
        filterColorPresets: ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)],
      }),
    });
    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());
  });

  it("discards a detached preset draft on Cancel without contacting main", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });
    await screen.getByRole("button", { name: "Appearance" }).click();
    await screen.getByRole("button", { name: "Filter preset 1 color" }).click();
    await screen.getByLabelText("Hex").fill("#11223380");
    await screen.getByRole("button", { name: "Apply" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();

    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());
    expect(eventMocks.request).not.toHaveBeenCalled();
    expect(eventMocks.requestPreview).toHaveBeenCalledExactlyOnceWith({
      sessionId: "active-session",
      revision: 1,
      appearance: { theme: "dark", highlightColors: {} },
    });
    expect(eventMocks.requestPreview.mock.calls[0][0]).not.toHaveProperty("filterColorPresets");
  });

  it("rebaselines imported presets in the detached window before a clean Escape", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    eventMocks.onResult.mockImplementationOnce((handler) => {
      eventMocks.resultHandler = handler;
      return Promise.resolve(() => {});
    });
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });

    await screen.getByTitle(/Import settings from a JSON file/).click();
    await vi.waitFor(() => expect(eventMocks.request).toHaveBeenCalledOnce());
    const previewRequest = eventMocks.request.mock.calls[0][0] as { requestId: string };
    eventMocks.resultHandler?.({
      sessionId: "active-session",
      requestId: previewRequest.requestId,
      ok: true,
      sections: [{ id: "appearance", label: "Appearance", detail: "10 filter color presets" }],
    });
    await expect
      .element(screen.getByText(/Import applies the checked settings immediately/))
      .toBeVisible();
    await screen.getByRole("button", { name: "Import", exact: true }).click();
    await vi.waitFor(() => expect(eventMocks.request).toHaveBeenCalledTimes(2));
    const applyRequest = eventMocks.request.mock.calls[1][0] as { requestId: string };
    const importedPresets = ["#11223380", ...DEFAULT_FILTER_COLOR_PRESETS.slice(1)];
    eventMocks.resultHandler?.({
      sessionId: "active-session",
      requestId: applyRequest.requestId,
      ok: true,
      snapshot: snapshot(2, 8080, { filterColorPresets: importedPresets }),
    });

    await screen.getByRole("button", { name: "Appearance" }).click();
    await screen.getByRole("button", { name: "Filter preset 1 color" }).click();
    await expect.element(screen.getByLabelText("Hex")).toHaveValue("#11223380");
    await screen
      .getByRole("dialog", { name: "Filter preset 1 color" })
      .getByRole("button", { name: "Cancel" })
      .click();
    await userEvent.keyboard("{Escape}");

    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());
    await expect
      .element(screen.getByRole("dialog", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
  });

  it("routes Escape and native X directly to destruction before state is seeded", async () => {
    const screen = await render(<SettingsWindow sessionId="failed-session" />);
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());

    vi.clearAllMocks();
    const preventDefault = vi.fn();
    windowMocks.closeHandler?.({ preventDefault });
    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("restores usable saved UI when actual destruction fails after Save", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    eventMocks.onResult.mockImplementationOnce((handler) => {
      eventMocks.resultHandler = handler;
      return Promise.resolve(() => {});
    });
    windowMocks.close.mockRejectedValueOnce(new Error("destroy denied"));
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });
    await screen.getByRole("spinbutton").fill("9090");
    await screen.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => expect(eventMocks.request).toHaveBeenCalledOnce());
    const request = eventMocks.request.mock.calls[0][0] as { requestId: string };

    eventMocks.resultHandler?.({
      sessionId: "active-session",
      requestId: request.requestId,
      ok: true,
      // The result includes a main-only exclusion queued while the full save
      // was in flight. If native destruction then fails, this result becomes
      // the restored child baseline and must retain both M and N.
      snapshot: snapshot(2, 9090, { excludedHosts: ["queued.example.test"] }),
    });

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Could not close Settings: Error: destroy denied",
      ),
    );
    await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect.element(screen.getByRole("spinbutton")).toHaveValue(9090);
    await screen.getByRole("button", { name: "Interception" }).click();
    await expect.element(screen.getByText("queued.example.test")).toBeVisible();
    expect(eventMocks.sendShutdown).not.toHaveBeenCalled();
    expect(eventMocks.resumePreview).toHaveBeenCalledWith({ sessionId: "active-session" });

    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(windowMocks.close).toHaveBeenCalledTimes(2));
  });

  it("cancels shutdown and stays usable when destruction fails", async () => {
    eventMocks.onState.mockImplementationOnce((handler) => {
      eventMocks.stateHandler = handler;
      return Promise.resolve(() => {});
    });
    eventMocks.onResult.mockImplementationOnce((handler) => {
      eventMocks.resultHandler = handler;
      return Promise.resolve(() => {});
    });
    windowMocks.close.mockRejectedValueOnce(new Error("destroy denied"));
    const screen = await render(<SettingsWindow sessionId="active-session" />);
    await vi.waitFor(() => expect(eventMocks.announceReady).toHaveBeenCalledOnce());
    eventMocks.stateHandler?.({ sessionId: "active-session", snapshot: snapshot(1, 8080) });

    eventMocks.shutdownHandler?.({ sessionId: "active-session", requestId: "shutdown-1" });

    await vi.waitFor(() =>
      expect(eventMocks.sendShutdown).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "active-session",
          requestId: "shutdown-1",
          ok: false,
          error: expect.stringContaining("destroy denied"),
        }),
      ),
    );
    await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(eventMocks.resumePreview).toHaveBeenCalledWith({ sessionId: "active-session" });
  });
});
