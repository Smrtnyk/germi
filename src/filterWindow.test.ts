import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterWindowReady } from "./filterWindowProtocol";

const mocks = vi.hoisted(() => ({
  ready: null as ((payload: FilterWindowReady) => void) | null,
  nativeDestroyed: null as (() => void) | null,
  open: vi.fn<
    (
      label: string,
      options: { url: string },
      signal?: AbortSignal,
    ) => Promise<"created" | "focused">
  >(),
  focus: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  destroyUnready: vi.fn(() => {
    mocks.nativeDestroyed?.();
    return Promise.resolve();
  }),
  listenDestroyed: vi.fn(),
  unlistenDestroyed: vi.fn(),
  getByLabel: vi.fn(),
  unlisten: vi.fn(),
  onReady: vi.fn(),
}));

vi.mock("./windows", () => ({ openOrFocusWindow: mocks.open }));
vi.mock("./filterWindowEvents", () => ({ onFilterWindowReady: mocks.onReady }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: mocks.destroy }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: mocks.getByLabel },
}));

import {
  cancelPendingFilterWindowOpen,
  closeFilterWindow,
  FILTER_WINDOW_LABEL,
  FILTER_WINDOW_OPTIONS,
  FILTER_WINDOW_READY_TIMEOUT_MS,
  FILTER_WINDOW_SESSION_PARAM,
  filterWindowSessionId,
  isFilterWindowOpenCancelled,
  openOrFocusFilterWindow,
} from "./filterWindow";

function sessionFromOpen(index = 0): string {
  const [, options] = mocks.open.mock.calls[index] as [string, typeof FILTER_WINDOW_OPTIONS];
  return new URLSearchParams(options.url.split("?")[1]).get(FILTER_WINDOW_SESSION_PARAM) ?? "";
}

function announceReady(sessionId: string, incarnation = 1): void {
  mocks.ready?.({ sessionId, incarnation });
}

describe("filter window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ready = null;
    mocks.nativeDestroyed = null;
    mocks.onReady.mockImplementation((handler: (payload: FilterWindowReady) => void) => {
      mocks.ready = handler;
      return Promise.resolve(mocks.unlisten);
    });
    mocks.getByLabel.mockImplementation((label: string) =>
      Promise.resolve(
        label === "main"
          ? { setFocus: mocks.focus }
          : { destroy: mocks.destroyUnready, once: mocks.listenDestroyed },
      ),
    );
    mocks.listenDestroyed.mockImplementation((_event: string, handler: () => void) => {
      mocks.nativeDestroyed = handler;
      return Promise.resolve(mocks.unlistenDestroyed);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps first open pending until the live child claims its native session", async () => {
    mocks.open.mockResolvedValue("created");

    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    let settled = false;
    void opened.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const [label, options] = mocks.open.mock.calls[0] as [string, typeof FILTER_WINDOW_OPTIONS];
    const sessionId = sessionFromOpen();
    expect(label).toBe(FILTER_WINDOW_LABEL);
    expect(options).toMatchObject({
      ...FILTER_WINDOW_OPTIONS,
      url: expect.stringContaining("filter=1"),
    });
    expect(sessionId).not.toBe("");
    expect(FILTER_WINDOW_OPTIONS).not.toHaveProperty("parent");

    announceReady(sessionId);
    await expect(opened).resolves.toBe("created");
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("has no post-created bind callback that can trigger the reported URL inspection error", async () => {
    mocks.open.mockResolvedValue("created");
    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());

    expect(mocks.open.mock.calls[0]).toHaveLength(3);
    expect(mocks.open.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    announceReady(sessionFromOpen());
    await expect(opened).resolves.toBe("created");
  });

  it("focuses an existing ready singleton without waiting for a new child claim", async () => {
    mocks.open.mockResolvedValue("focused");

    await expect(openOrFocusFilterWindow()).resolves.toBe("focused");

    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.destroyUnready).not.toHaveBeenCalled();
  });

  it("shares one pending open through readiness so a double-click cannot create twice", async () => {
    mocks.open.mockResolvedValue("created");
    const first = openOrFocusFilterWindow();
    const second = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());

    announceReady(sessionFromOpen());
    await expect(first).resolves.toBe("created");
    await expect(second).resolves.toBe("created");
  });

  it("ignores a delayed old ready event while waiting for the current native session", async () => {
    mocks.open.mockResolvedValue("created");
    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    let settled = false;
    void opened.finally(() => {
      settled = true;
    });

    announceReady("old-session", 12);
    await Promise.resolve();
    expect(settled).toBe(false);
    announceReady(sessionFromOpen(), 13);
    await expect(opened).resolves.toBe("created");
  });

  it("clears a failed creation so the next invocation can retry", async () => {
    mocks.open.mockRejectedValueOnce(new Error("label race")).mockResolvedValueOnce("created");
    await expect(openOrFocusFilterWindow()).rejects.toThrow("label race");

    const retried = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    announceReady(sessionFromOpen(1));
    await expect(retried).resolves.toBe("created");
  });

  it("does not retry until a timed-out native window is actually destroyed", async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue("created");
    mocks.destroyUnready.mockResolvedValueOnce(undefined);
    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(FILTER_WINDOW_READY_TIMEOUT_MS);
    expect(mocks.destroyUnready).toHaveBeenCalledOnce();
    let settled = false;
    void opened.catch(() => {
      settled = true;
    });
    const shared = openOrFocusFilterWindow();
    expect(shared).toBe(opened);
    await Promise.resolve();
    expect(settled).toBe(false);

    mocks.nativeDestroyed?.();
    await expect(opened).rejects.toThrow("did not become ready");

    mocks.open.mockResolvedValueOnce("created");
    const retried = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    announceReady(sessionFromOpen(1));
    await expect(retried).resolves.toBe("created");
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });

  it("times out even when the native creation invoke never settles", async () => {
    vi.useFakeTimers();
    mocks.open.mockImplementation(() => new Promise(() => {}));
    mocks.getByLabel.mockResolvedValue(null);

    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(FILTER_WINDOW_READY_TIMEOUT_MS);

    await expect(opened).rejects.toThrow("did not become ready");
    expect(mocks.open.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  it("does not hang when timeout cleanup finds no native window", async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue("created");
    mocks.getByLabel.mockResolvedValue(null);

    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(FILTER_WINDOW_READY_TIMEOUT_MS);

    await expect(opened).rejects.toThrow("did not become ready");
    expect(mocks.destroyUnready).not.toHaveBeenCalled();
  });

  it("falls back to manager removal when the destroyed listener cannot attach", async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue("created");
    mocks.listenDestroyed.mockRejectedValueOnce(new Error("listener unavailable"));
    mocks.getByLabel
      .mockResolvedValueOnce({ destroy: mocks.destroyUnready, once: mocks.listenDestroyed })
      .mockResolvedValueOnce(null);

    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(FILTER_WINDOW_READY_TIMEOUT_MS);

    await expect(opened).rejects.toThrow("did not become ready");
    expect(mocks.destroyUnready).toHaveBeenCalledOnce();
  });

  it("cancels and destroys a still-unready open when its main owner disposes", async () => {
    mocks.open.mockResolvedValue("created");
    const opened = openOrFocusFilterWindow();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());

    await expect(cancelPendingFilterWindowOpen()).resolves.toBeUndefined();
    await expect(opened).rejects.toSatisfy(isFilterWindowOpenCancelled);
    expect(mocks.destroyUnready).toHaveBeenCalledOnce();
  });

  it("reads only the creation token from the child route", () => {
    expect(filterWindowSessionId("?filter=1&filterSession=session%20one")).toBe("session one");
    expect(filterWindowSessionId("?filter=1")).toBe("");
  });

  it("returns focus to main before destroying the child", async () => {
    await closeFilterWindow();
    expect(mocks.getByLabel).toHaveBeenCalledWith("main");
    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.focus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.destroy.mock.invocationCallOrder[0],
    );
  });

  it("still destroys the child when looking up the main window rejects", async () => {
    mocks.getByLabel.mockRejectedValueOnce(new Error("main unavailable"));

    await expect(closeFilterWindow()).resolves.toBeUndefined();

    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("still destroys the child when returning focus rejects", async () => {
    mocks.focus.mockRejectedValueOnce(new Error("focus denied"));

    await expect(closeFilterWindow()).resolves.toBeUndefined();

    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
