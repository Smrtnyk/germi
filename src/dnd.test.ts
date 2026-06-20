import { describe, expect, it } from "vitest";

import {
  decodeFlowIds,
  dragFlowIds,
  encodeFlowIds,
  FLOW_DRAG_MIME,
  hasFlowDrag,
  RULE_DRAG_MIME,
} from "./dnd";

const order = ["a", "b", "c", "d"];

describe("dragFlowIds", () => {
  it("drags only the grabbed row when it is not in the selection", () => {
    expect(dragFlowIds("c", new Set(["a", "b"]), order)).toEqual(["c"]);
  });

  it("drags only the grabbed row when nothing is selected", () => {
    expect(dragFlowIds("c", new Set(), order)).toEqual(["c"]);
  });

  it("drags the whole selection when the grabbed row is part of it", () => {
    expect(dragFlowIds("b", new Set(["d", "b"]), order)).toEqual(["b", "d"]);
  });

  it("keeps capture order regardless of selection insertion order", () => {
    expect(dragFlowIds("d", new Set(["d", "a", "c"]), order)).toEqual(["a", "c", "d"]);
  });

  it("drags just the row for a single-row selection (no needless fan-out)", () => {
    expect(dragFlowIds("a", new Set(["a"]), order)).toEqual(["a"]);
  });

  it("falls back to the grabbed row if the selection is not in the ordered list", () => {
    expect(dragFlowIds("z", new Set(["z", "y"]), order)).toEqual(["z"]);
  });
});

describe("encode / decode round-trip", () => {
  it("round-trips a list of ids", () => {
    const ids = ["x1", "x2", "x3"];
    expect(decodeFlowIds(encodeFlowIds(ids))).toEqual(ids);
  });

  it("returns [] for malformed JSON", () => {
    expect(decodeFlowIds("not json")).toEqual([]);
    expect(decodeFlowIds("")).toEqual([]);
  });

  it("returns [] for the wrong shape", () => {
    expect(decodeFlowIds(JSON.stringify({ id: "a" }))).toEqual([]);
    expect(decodeFlowIds(JSON.stringify([1, 2, 3]))).toEqual([]);
    expect(decodeFlowIds(JSON.stringify(["a", 2]))).toEqual([]);
  });
});

describe("hasFlowDrag", () => {
  it("detects our MIME type among the drag types", () => {
    expect(hasFlowDrag([FLOW_DRAG_MIME])).toBe(true);
    expect(hasFlowDrag(["text/plain", FLOW_DRAG_MIME])).toBe(true);
  });

  it("ignores other drags (e.g. rule reorder, which uses its own MIME type)", () => {
    expect(hasFlowDrag([])).toBe(false);
    expect(hasFlowDrag(["text/plain"])).toBe(false);
    expect(hasFlowDrag([RULE_DRAG_MIME])).toBe(false);
  });
});
