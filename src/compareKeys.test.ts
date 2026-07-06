import { describe, expect, it, vi } from "vitest";

import { handleCompareKeys, type CompareKeyActions } from "./compareKeys";

function actions(overrides: Partial<CompareKeyActions> = {}): CompareKeyActions {
  return {
    diffOpen: false,
    canDiff: false,
    openDiff: vi.fn(),
    closeDiff: vi.fn(),
    close: vi.fn(),
    moveSelectedRight: vi.fn(),
    moveSelectedLeft: vi.fn(),
    stepActive: vi.fn(),
    selectAllActive: vi.fn(),
    ...overrides,
  };
}

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent;
}

describe("select-all (issue #104)", () => {
  it("marks every visible row of the active pane on Ctrl+A and blocks text selection", () => {
    const ctx = actions();
    const e = keyEvent({ key: "a", ctrlKey: true });
    handleCompareKeys(e, ctx);
    expect(ctx.selectAllActive).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("also fires on ⌘+A for macOS", () => {
    const ctx = actions();
    handleCompareKeys(keyEvent({ key: "a", metaKey: true }), ctx);
    expect(ctx.selectAllActive).toHaveBeenCalledOnce();
  });

  it("is case-insensitive so a shifted 'A' still selects all", () => {
    const ctx = actions();
    handleCompareKeys(keyEvent({ key: "A", ctrlKey: true, shiftKey: true }), ctx);
    expect(ctx.selectAllActive).toHaveBeenCalledOnce();
  });

  it("stays out of the way while typing in a pane filter", () => {
    const ctx = actions();
    const e = keyEvent({ key: "a", ctrlKey: true, target: { tagName: "INPUT" } as HTMLElement });
    handleCompareKeys(e, ctx);
    expect(ctx.selectAllActive).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+A to the browser while the diff is open so the diff text is selectable", () => {
    const ctx = actions({ diffOpen: true });
    const e = keyEvent({ key: "a", ctrlKey: true });
    handleCompareKeys(e, ctx);
    expect(ctx.selectAllActive).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores an unmodified 'a' keystroke", () => {
    const ctx = actions();
    const e = keyEvent({ key: "a" });
    handleCompareKeys(e, ctx);
    expect(ctx.selectAllActive).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("closes the window from the picker", () => {
    const ctx = actions();
    handleCompareKeys(keyEvent({ key: "Escape" }), ctx);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(ctx.closeDiff).not.toHaveBeenCalled();
  });

  it("steps back from the diff before closing", () => {
    const ctx = actions({ diffOpen: true });
    handleCompareKeys(keyEvent({ key: "Escape" }), ctx);
    expect(ctx.closeDiff).toHaveBeenCalledOnce();
    expect(ctx.close).not.toHaveBeenCalled();
  });
});

describe("Enter opens the diff", () => {
  it("opens the diff for the focused pair", () => {
    const ctx = actions({ canDiff: true });
    const e = keyEvent({ key: "Enter", target: { closest: () => null } as unknown as HTMLElement });
    handleCompareKeys(e, ctx);
    expect(ctx.openDiff).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("does nothing without a full pair", () => {
    const ctx = actions({ canDiff: false });
    handleCompareKeys(
      keyEvent({ key: "Enter", target: { closest: () => null } as unknown as HTMLElement }),
      ctx,
    );
    expect(ctx.openDiff).not.toHaveBeenCalled();
  });

  it("lets Enter on a button activate it instead of diffing", () => {
    const ctx = actions({ canDiff: true });
    const e = keyEvent({
      key: "Enter",
      target: {
        closest: (sel: string) => (sel === "button" ? {} : null),
      } as unknown as HTMLElement,
    });
    handleCompareKeys(e, ctx);
    expect(ctx.openDiff).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("arrow navigation", () => {
  it("steps the active pane down and up, extending with shift", () => {
    const ctx = actions();
    handleCompareKeys(keyEvent({ key: "ArrowDown" }), ctx);
    expect(ctx.stepActive).toHaveBeenCalledWith(1, false);
    handleCompareKeys(keyEvent({ key: "ArrowUp", shiftKey: true }), ctx);
    expect(ctx.stepActive).toHaveBeenCalledWith(-1, true);
  });

  it("moves the selection across panes", () => {
    const ctx = actions();
    handleCompareKeys(keyEvent({ key: "ArrowRight" }), ctx);
    handleCompareKeys(keyEvent({ key: "ArrowLeft" }), ctx);
    expect(ctx.moveSelectedRight).toHaveBeenCalledOnce();
    expect(ctx.moveSelectedLeft).toHaveBeenCalledOnce();
  });
});
