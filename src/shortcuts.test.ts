import { describe, expect, it } from "vitest";

import {
  accelFromEvent,
  DEFAULT_SHORTCUTS,
  findConflict,
  prettyShortcut,
  resolveBindings,
  reverseLookup,
} from "./shortcuts";

type EventParts = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">;

function ev(o: Partial<EventParts>): EventParts {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...o };
}

describe("accelFromEvent", () => {
  it("collapses Ctrl and Cmd into a single Mod", () => {
    expect(accelFromEvent(ev({ ctrlKey: true, code: "KeyK" }))).toBe("Mod+K");
    expect(accelFromEvent(ev({ metaKey: true, code: "KeyK" }))).toBe("Mod+K");
    expect(accelFromEvent(ev({ ctrlKey: true, metaKey: true, code: "KeyK" }))).toBe("Mod+K");
  });

  it("handles digits and orders modifiers Mod, Alt, Shift", () => {
    expect(accelFromEvent(ev({ ctrlKey: true, code: "Digit1" }))).toBe("Mod+1");
    expect(accelFromEvent(ev({ ctrlKey: true, shiftKey: true, code: "KeyZ" }))).toBe("Mod+Shift+Z");
    expect(accelFromEvent(ev({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyG" }))).toBe(
      "Mod+Alt+Shift+G",
    );
  });

  it("allows a bare function key", () => {
    expect(accelFromEvent(ev({ code: "F2" }))).toBe("F2");
    expect(accelFromEvent(ev({ shiftKey: true, code: "F5" }))).toBe("Shift+F5");
  });

  it("rejects bare keys, Shift-only, and modifier-only events", () => {
    expect(accelFromEvent(ev({ code: "KeyK" }))).toBeNull();
    expect(accelFromEvent(ev({ code: "Digit1" }))).toBeNull();
    expect(accelFromEvent(ev({ shiftKey: true, code: "KeyP" }))).toBeNull();
    expect(accelFromEvent(ev({ ctrlKey: true, code: "ControlLeft" }))).toBeNull();
    expect(accelFromEvent(ev({ ctrlKey: true, code: "Space" }))).toBeNull();
  });
});

describe("prettyShortcut", () => {
  it("renders modifiers and the key", () => {
    expect(prettyShortcut("Mod+K")).toBe("Ctrl / ⌘ K");
    expect(prettyShortcut("Mod+Shift+Z")).toBe("Ctrl / ⌘ Shift Z");
    expect(prettyShortcut("F2")).toBe("F2");
  });
});

describe("resolveBindings", () => {
  it("returns the defaults for null or garbage", () => {
    expect(resolveBindings(null)).toEqual(DEFAULT_SHORTCUTS);
    expect(resolveBindings("nope")).toEqual(DEFAULT_SHORTCUTS);
  });

  it("merges valid overrides and ignores unknown ids", () => {
    const merged = resolveBindings({ palette: "Mod+J", bogus: "Mod+Q" });
    expect(merged.palette).toBe("Mod+J");
    expect(merged.save).toBe(DEFAULT_SHORTCUTS.save);
    expect((merged as Record<string, string>).bogus).toBeUndefined();
  });

  it("falls back to the default for a missing command", () => {
    expect(resolveBindings({ palette: "Mod+J" }).save).toBe("Mod+S");
  });
});

describe("reverseLookup", () => {
  it("maps each default accel back to its command", () => {
    const rev = reverseLookup(DEFAULT_SHORTCUTS);
    expect(rev.get("Mod+K")).toBe("palette");
    expect(rev.get("F2")).toBe("edit-mock-body");
    expect(rev.size).toBe(Object.keys(DEFAULT_SHORTCUTS).length);
  });
});

describe("findConflict", () => {
  it("detects another command already using the accel", () => {
    expect(findConflict(DEFAULT_SHORTCUTS, "Mod+S", "palette")).toEqual({
      kind: "command",
      id: "save",
    });
  });

  it("ignores the command's own current accel", () => {
    expect(findConflict(DEFAULT_SHORTCUTS, "Mod+S", "save")).toBeNull();
  });

  it("flags reserved accels", () => {
    expect(findConflict(DEFAULT_SHORTCUTS, "Mod+A", "palette")).toEqual({ kind: "reserved" });
    expect(findConflict(DEFAULT_SHORTCUTS, "Mod+C", "palette")).toEqual({ kind: "reserved" });
  });

  it("returns null for a free accel", () => {
    expect(findConflict(DEFAULT_SHORTCUTS, "Mod+J", "palette")).toBeNull();
  });
});
