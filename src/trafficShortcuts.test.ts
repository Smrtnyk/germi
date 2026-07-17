import { describe, expect, it } from "vitest";

import { isClearTrafficShortcut } from "./trafficShortcuts";

function shortcut(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "x",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
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
});
