import { describe, expect, it, vi } from "vitest";

import { handleClearTrafficShortcut, isClearTrafficShortcut } from "./trafficShortcuts";

function shortcut(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "x",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as KeyboardEvent;
}

describe("isClearTrafficShortcut", () => {
  it("accepts Ctrl+X and Cmd+X only within the traffic list", () => {
    expect(isClearTrafficShortcut(shortcut(), true)).toBe(true);
    expect(isClearTrafficShortcut(shortcut({ ctrlKey: false, metaKey: true }), true)).toBe(true);
    expect(isClearTrafficShortcut(shortcut(), false)).toBe(false);
  });

  it("does not claim modified or unrelated clipboard shortcuts", () => {
    expect(isClearTrafficShortcut(shortcut({ shiftKey: true }), true)).toBe(false);
    expect(isClearTrafficShortcut(shortcut({ altKey: true }), true)).toBe(false);
    expect(isClearTrafficShortcut(shortcut({ key: "c" }), true)).toBe(false);
  });

  it("clears immediately and claims the matching keyboard event", () => {
    const event = shortcut();
    const clearTraffic = vi.fn();

    expect(handleClearTrafficShortcut(event, true, clearTraffic)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(clearTraffic).toHaveBeenCalledOnce();
  });

  it("leaves unrelated keyboard events and traffic untouched", () => {
    const event = shortcut({ key: "c" });
    const clearTraffic = vi.fn();

    expect(handleClearTrafficShortcut(event, true, clearTraffic)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clearTraffic).not.toHaveBeenCalled();
  });
});
