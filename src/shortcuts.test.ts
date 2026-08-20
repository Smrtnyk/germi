import { describe, expect, it, vi } from "vitest";

import {
  accelFromEvent,
  assignBinding,
  commandFromEvent,
  DEFAULT_SHORTCUTS,
  dispatchShortcutCommand,
  findConflict,
  prettyShortcut,
  resolveBindings,
  reverseLookup,
  SHORTCUT_COMMANDS,
  type CommandId,
} from "./shortcuts";

type EventParts = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">;

function ev(o: Partial<EventParts>): EventParts {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...o };
}

function commandActions(): Record<CommandId, () => void> {
  const actions = {} as Record<CommandId, () => void>;
  for (const { id } of SHORTCUT_COMMANDS) actions[id] = vi.fn();
  return actions;
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

  it("preserves an explicitly cleared command", () => {
    expect(resolveBindings({ "create-filter": "" })["create-filter"]).toBe("");
  });

  it("leaves a new command unbound when its default conflicts with an older override", () => {
    const migrated = resolveBindings({ "focus-filter": "Mod+Shift+F" });
    expect(migrated["focus-filter"]).toBe("Mod+Shift+F");
    expect(migrated["create-filter"]).toBe("");
  });
});

describe("reverseLookup", () => {
  it("maps each default accel back to its command", () => {
    const rev = reverseLookup(DEFAULT_SHORTCUTS);
    expect(rev.get("Mod+K")).toBe("palette");
    expect(rev.get("F2")).toBe("edit-mock-body");
    expect(rev.size).toBe(Object.keys(DEFAULT_SHORTCUTS).length);
  });

  it("ignores unbound commands", () => {
    const bindings = { ...DEFAULT_SHORTCUTS, "create-filter": "" };
    expect(reverseLookup(bindings).has("")).toBe(false);
  });
});

describe("assignBinding", () => {
  it("swaps a conflicting chord so Ctrl/Cmd+F can move between filter actions", () => {
    const result = assignBinding(DEFAULT_SHORTCUTS, "create-filter", "Mod+F");
    expect(result).toEqual({
      ok: true,
      bindings: {
        ...DEFAULT_SHORTCUTS,
        "focus-filter": "Mod+Shift+F",
        "create-filter": "Mod+F",
      },
      swappedWith: "focus-filter",
    });
  });

  it("can explicitly unassign a command", () => {
    const result = assignBinding(DEFAULT_SHORTCUTS, "create-filter", "");
    expect(result.ok && result.bindings["create-filter"]).toBe("");
  });

  it("refuses reserved chords without changing bindings", () => {
    expect(assignBinding(DEFAULT_SHORTCUTS, "create-filter", "Mod+C")).toEqual({
      ok: false,
      conflict: { kind: "reserved" },
    });
  });
});

describe("commandFromEvent", () => {
  it("dispatches only the owner after a swap and ignores an unbound command", () => {
    const swapped = assignBinding(DEFAULT_SHORTCUTS, "create-filter", "Mod+F");
    if (!swapped.ok) throw new Error("unexpected reserved shortcut");
    const reverse = reverseLookup(swapped.bindings);
    expect(commandFromEvent(reverse, ev({ ctrlKey: true, code: "KeyF" }))).toBe("create-filter");
    expect(commandFromEvent(reverse, ev({ ctrlKey: true, shiftKey: true, code: "KeyF" }))).toBe(
      "focus-filter",
    );

    const cleared = assignBinding(swapped.bindings, "create-filter", "");
    if (!cleared.ok) throw new Error("unexpected reserved shortcut");
    expect(
      commandFromEvent(reverseLookup(cleared.bindings), ev({ ctrlKey: true, code: "KeyF" })),
    ).toBeNull();
  });
});

describe("dispatchShortcutCommand", () => {
  it("runs only create-filter from the top filter input after a Ctrl/Cmd+F swap", () => {
    const swapped = assignBinding(DEFAULT_SHORTCUTS, "create-filter", "Mod+F");
    if (!swapped.ok) throw new Error("unexpected reserved shortcut");
    const actions = commandActions();
    const preventDefault = vi.fn();
    const result = dispatchShortcutCommand(
      reverseLookup(swapped.bindings),
      { ...ev({ ctrlKey: true, code: "KeyF" }), preventDefault },
      actions,
      { editing: true, fromFilterInput: true, modalOpen: false },
    );
    expect(result).toBe("handled");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(actions["create-filter"]).toHaveBeenCalledOnce();
    expect(actions["focus-filter"]).not.toHaveBeenCalled();
  });

  it("consumes create-filter while a modal owns the window without running it", () => {
    const actions = commandActions();
    const preventDefault = vi.fn();
    const result = dispatchShortcutCommand(
      reverseLookup(DEFAULT_SHORTCUTS),
      { ...ev({ ctrlKey: true, shiftKey: true, code: "KeyF" }), preventDefault },
      actions,
      { editing: true, fromFilterInput: false, modalOpen: true },
    );
    expect(result).toBe("handled");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(actions["create-filter"]).not.toHaveBeenCalled();
  });

  it("leaves the create-filter chord alone in unrelated editors", () => {
    const actions = commandActions();
    const preventDefault = vi.fn();
    const result = dispatchShortcutCommand(
      reverseLookup(DEFAULT_SHORTCUTS),
      { ...ev({ ctrlKey: true, shiftKey: true, code: "KeyF" }), preventDefault },
      actions,
      { editing: true, fromFilterInput: false, modalOpen: false },
    );
    expect(result).toBe("ignored");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(actions["create-filter"]).not.toHaveBeenCalled();
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
