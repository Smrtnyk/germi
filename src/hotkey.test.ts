import { describe, expect, it } from "vitest";
import { accelFromKeyboardEvent, prettyAccel } from "./hotkey";

function ev(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
    ...overrides,
  } as KeyboardEvent;
}

describe("accelFromKeyboardEvent", () => {
  it("builds a Tauri accelerator from modifiers + a letter", () => {
    expect(accelFromKeyboardEvent(ev({ ctrlKey: true, shiftKey: true, code: "KeyP" }))).toBe(
      "CmdOrCtrl+Shift+P",
    );
  });

  it("orders modifiers CmdOrCtrl, Alt, Shift", () => {
    expect(
      accelFromKeyboardEvent(ev({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyG" })),
    ).toBe("CmdOrCtrl+Alt+Shift+G");
  });

  it("supports digits and function keys", () => {
    expect(accelFromKeyboardEvent(ev({ altKey: true, code: "Digit1" }))).toBe("Alt+1");
    expect(accelFromKeyboardEvent(ev({ ctrlKey: true, code: "F5" }))).toBe("CmdOrCtrl+F5");
  });

  it("supports the Super/Win key (e.g. Win+F12)", () => {
    expect(accelFromKeyboardEvent(ev({ metaKey: true, code: "F12" }))).toBe("Super+F12");
    expect(accelFromKeyboardEvent(ev({ ctrlKey: true, metaKey: true, code: "KeyK" }))).toBe(
      "CmdOrCtrl+Super+K",
    );
  });

  it("rejects a bare key with no modifier", () => {
    expect(accelFromKeyboardEvent(ev({ code: "KeyP" }))).toBeNull();
  });

  it("rejects Shift-only combos (Shift isn't a real global modifier)", () => {
    expect(accelFromKeyboardEvent(ev({ shiftKey: true, code: "KeyP" }))).toBeNull();
  });

  it("rejects a modifier with no main key", () => {
    expect(accelFromKeyboardEvent(ev({ ctrlKey: true, code: "ShiftLeft" }))).toBeNull();
  });

  it("rejects unsupported keys", () => {
    expect(accelFromKeyboardEvent(ev({ ctrlKey: true, code: "Space" }))).toBeNull();
  });
});

describe("prettyAccel", () => {
  it("renders CmdOrCtrl as Ctrl and Super as Win for display", () => {
    expect(prettyAccel("CmdOrCtrl+Alt+Shift+P")).toBe("Ctrl+Alt+Shift+P");
    expect(prettyAccel("Super+F12")).toBe("Win+F12");
  });
});
