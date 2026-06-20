import { describe, expect, it } from "vitest";

import { nextIdAfterDelete } from "./selection";

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
