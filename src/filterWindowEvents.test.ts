import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterWindowClosed, FilterWindowReady } from "./filterWindowProtocol";

const mocks = vi.hoisted(() => {
  type Handler = (event: { payload: unknown }) => void;
  const listeners = new Map<string, Set<Handler>>();
  const invoke = vi.fn();
  const emit = vi.fn((event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) handler({ payload });
    return Promise.resolve();
  });
  const listen = vi.fn((event: string, handler: Handler) => {
    const handlers = listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return Promise.resolve(() => handlers.delete(handler));
  });
  return { emit, invoke, listen, listeners };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit, listen: mocks.listen }));

import {
  onFilterWindowClosed,
  onFilterWindowReady,
  requestFilterWindowState,
} from "./filterWindowEvents";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
});

describe("filter-window lifecycle events", () => {
  it("lets only the live child register and emits its backend-issued incarnation", async () => {
    const ready: FilterWindowReady = { sessionId: "current", incarnation: 7 };
    mocks.invoke.mockResolvedValue(ready);
    const receive = vi.fn();
    await onFilterWindowReady(receive);

    await requestFilterWindowState({ sessionId: "current" });

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("register_filter_window_session", {
      sessionId: "current",
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("bind_filter_window_session", expect.anything());
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith("germi://filter-window-ready", ready);
    expect(receive).toHaveBeenCalledExactlyOnceWith(ready);
  });

  it("forwards the destroyed window's scoped close payload", async () => {
    const closed: FilterWindowClosed = { sessionId: "old", incarnation: 4 };
    const receive = vi.fn();
    await onFilterWindowClosed(receive);

    await mocks.emit("germi://filter-window-closed", closed);

    expect(receive).toHaveBeenCalledExactlyOnceWith(closed);
  });
});
