import { describe, expect, it } from "vitest";

import { nextIdAfterDelete, toggleSelection } from "./selection";

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
