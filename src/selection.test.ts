import { describe, expect, it } from "vitest";

import {
  capturedDeletePlan,
  clickSelection,
  nextIdAfterDelete,
  pruneSelection,
  toggleSelection,
} from "./selection";

const order = ["a", "b", "c", "d", "e"];

describe("nextIdAfterDelete", () => {
  it("selects the row that slides into the deleted focused slot", () => {
    expect(nextIdAfterDelete(order, new Set(["c"]), "c")).toBe("d");
  });

  it("keeps walking down across repeated single deletes (del/down/del workflow)", () => {
    expect(nextIdAfterDelete(order, new Set(["c"]), "c")).toBe("d");
    expect(nextIdAfterDelete(order, new Set(["d"]), "d")).toBe("e");
    expect(nextIdAfterDelete(order, new Set(["e"]), "e")).toBe("d");
  });

  it("falls back to the new last row when the focused row was the tail", () => {
    expect(nextIdAfterDelete(order, new Set(["e"]), "e")).toBe("d");
  });

  it("falls back to the previous row when everything after the focused row is also deleted", () => {
    expect(nextIdAfterDelete(order, new Set(["c", "d", "e"]), "c")).toBe("b");
  });

  it("selects the row after a contiguous deleted block starting at the focus", () => {
    expect(nextIdAfterDelete(order, new Set(["b", "c"]), "b")).toBe("d");
  });

  it("keeps the focused row selected when it is not among the deleted ids", () => {
    expect(nextIdAfterDelete(order, new Set(["a", "e"]), "c")).toBe("c");
  });

  it("picks the new last row when there is no focused row but a selection exists", () => {
    expect(nextIdAfterDelete(order, new Set(["c"]), null)).toBe("e");
  });

  it("returns null when the whole list is deleted", () => {
    expect(nextIdAfterDelete(order, new Set(order), "c")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(nextIdAfterDelete([], new Set(), null)).toBeNull();
  });

  it("treats an unknown focused id as no focus (falls back to last remaining)", () => {
    expect(nextIdAfterDelete(order, new Set(["e"]), "zzz")).toBe("d");
  });
});

describe("capturedDeletePlan", () => {
  it("returns null when nothing was live-captured", () => {
    expect(capturedDeletePlan([{ id: "a", imported: true }], ["a"], "a")).toBeNull();
  });

  it("plans to delete every captured flow with its count", () => {
    const flows = [
      { id: "c1", imported: false },
      { id: "i1", imported: true },
      { id: "c2", imported: false },
    ];
    const plan = capturedDeletePlan(flows, ["c1", "i1", "c2"], null);
    expect(plan?.capturedCount).toBe(2);
    expect(plan?.deleted).toEqual(new Set(["c1", "c2"]));
  });

  it("lands the next selection on the next VISIBLE flow, skipping hidden rows", () => {
    const flows = [
      { id: "c1", imported: false },
      { id: "hidden", imported: true },
      { id: "shown", imported: true },
    ];
    const plan = capturedDeletePlan(flows, ["c1", "shown"], "c1");
    expect(plan?.nextId).toBe("shown");
  });
});

describe("toggleSelection", () => {
  it("deselects the only selected row, clearing the primary (issue #23)", () => {
    expect(toggleSelection(order, new Set(["b"]), "b", "b")).toEqual({
      selectedIds: new Set(),
      selectedId: null,
      anchor: "b",
    });
  });

  it("adds an unselected row and makes it the primary", () => {
    expect(toggleSelection(order, new Set(["a"]), "a", "c")).toEqual({
      selectedIds: new Set(["a", "c"]),
      selectedId: "c",
      anchor: "c",
    });
  });

  it("removes a selected non-primary row without moving the primary", () => {
    expect(toggleSelection(order, new Set(["a", "b", "c"]), "c", "a")).toEqual({
      selectedIds: new Set(["b", "c"]),
      selectedId: "c",
      anchor: "a",
    });
  });

  it("moves the primary to the bottom-most survivor when deselecting the primary", () => {
    expect(toggleSelection(order, new Set(["a", "c", "d"]), "d", "d")).toEqual({
      selectedIds: new Set(["a", "c"]),
      selectedId: "c",
      anchor: "d",
    });
  });

  it("keeps the primary on a still-selected row when an empty-set focus is impossible", () => {
    expect(toggleSelection(order, new Set(["b", "e"]), "e", "e")).toEqual({
      selectedIds: new Set(["b"]),
      selectedId: "b",
      anchor: "e",
    });
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a", "b"]);
    toggleSelection(order, input, "b", "b");
    expect(input).toEqual(new Set(["a", "b"]));
  });
});

describe("clickSelection", () => {
  const plain = { shiftKey: false, ctrlKey: false, metaKey: false };

  it("a plain click selects only that row and re-anchors there", () => {
    expect(clickSelection(order, new Set(["a", "b"]), "b", "a", "d", plain)).toEqual({
      selectedIds: new Set(["d"]),
      selectedId: "d",
      anchor: "d",
    });
  });

  it("ctrl-click toggles the row into the selection", () => {
    expect(
      clickSelection(order, new Set(["a"]), "a", "a", "c", { ...plain, ctrlKey: true }),
    ).toEqual({ selectedIds: new Set(["a", "c"]), selectedId: "c", anchor: "c" });
  });

  it("meta-click toggles too (macOS ⌘)", () => {
    expect(
      clickSelection(order, new Set(["a", "c"]), "c", "c", "c", { ...plain, metaKey: true }),
    ).toEqual({ selectedIds: new Set(["a"]), selectedId: "a", anchor: "c" });
  });

  it("shift-click selects the inclusive range from the anchor, keeping the anchor", () => {
    expect(
      clickSelection(order, new Set(["b"]), "b", "b", "d", { ...plain, shiftKey: true }),
    ).toEqual({ selectedIds: new Set(["b", "c", "d"]), selectedId: "d", anchor: "b" });
  });

  it("shift-click with no anchor falls back to a fresh single selection", () => {
    expect(clickSelection(order, new Set(), null, null, "c", { ...plain, shiftKey: true })).toEqual(
      {
        selectedIds: new Set(["c"]),
        selectedId: "c",
        anchor: "c",
      },
    );
  });

  it("shift-click whose anchor was evicted re-anchors on the clicked row", () => {
    expect(
      clickSelection(order, new Set(["c"]), "c", "gone", "d", { ...plain, shiftKey: true }),
    ).toEqual({ selectedIds: new Set(["d"]), selectedId: "d", anchor: "d" });
  });
});

describe("pruneSelection", () => {
  it("returns null when every selected row is still present (no work to do)", () => {
    expect(pruneSelection(order, new Set(["b", "d"]), "d", "b")).toBeNull();
  });

  it("drops rows that are no longer shown, in display order", () => {
    expect(pruneSelection(["a", "c", "e"], new Set(["a", "b", "c"]), "a", "a")).toEqual({
      selectedIds: new Set(["a", "c"]),
      selectedId: "a",
      anchor: "a",
    });
  });

  it("re-homes the active row onto the last survivor when it was dropped", () => {
    expect(pruneSelection(["a", "b"], new Set(["a", "b", "c"]), "c", "c")).toEqual({
      selectedIds: new Set(["a", "b"]),
      selectedId: "b",
      anchor: "b",
    });
  });

  it("keeps a surviving active row and anchor untouched while pruning others", () => {
    expect(pruneSelection(["a", "c", "d"], new Set(["a", "c", "e"]), "c", "a")).toEqual({
      selectedIds: new Set(["a", "c"]),
      selectedId: "c",
      anchor: "a",
    });
  });

  it("clears the active row and anchor when nothing survives", () => {
    expect(pruneSelection(["x", "y"], new Set(["a", "b"]), "a", "b")).toEqual({
      selectedIds: new Set(),
      selectedId: null,
      anchor: null,
    });
  });
});
