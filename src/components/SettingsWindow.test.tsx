import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_SHORTCUTS } from "../shortcuts";
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
  requestPreview: vi.fn(() => Promise.resolve()),
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
