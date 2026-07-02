import { describe, expect, it } from "vitest";

import {
  emptyPaneQuery,
  extractFlows,
  movePaneFlows,
  paneData,
  selectMany,
  selectOnly,
  selectRow,
  stepSelection,
  visiblePaneFlows,
  type PaneQuery,
} from "./comparePane";
import { summary } from "./flowFixtures";
import type { FlowSummary, ResourceKind } from "./types";

const FLOWS: FlowSummary[] = [
  summary({ id: "a", seq: 1, host: "api.test", path: "/users", kind: "xhr", status: 200 }),
  summary({ id: "b", seq: 2, host: "cdn.test", path: "/app.js", kind: "js", status: 304 }),
  summary({ id: "c", seq: 3, host: "api.test", path: "/orders", kind: "xhr", status: 500 }),
];

function query(overrides: Partial<PaneQuery> = {}): PaneQuery {
  return { ...emptyPaneQuery(), ...overrides };
}

describe("visiblePaneFlows", () => {
  it("returns everything in insertion order by default", () => {
    expect(visiblePaneFlows(FLOWS, query(), null).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the token filter with the main window's syntax", () => {
    const ids = visiblePaneFlows(FLOWS, query({ filter: "host:api.test status:5xx" }), null);
    expect(ids.map((f) => f.id)).toEqual(["c"]);
  });

  it("applies kind chips on top of the filter", () => {
    const kinds = new Set<ResourceKind>(["js"]);
    expect(visiblePaneFlows(FLOWS, query({ kinds }), null).map((f) => f.id)).toEqual(["b"]);
  });

  it("sorts by a column with a stable order and flips direction", () => {
    const asc = visiblePaneFlows(FLOWS, query({ sort: { columnId: "status", dir: "asc" } }), null);
    expect(asc.map((f) => f.id)).toEqual(["a", "b", "c"]);
    const desc = visiblePaneFlows(
      FLOWS,
      query({ sort: { columnId: "status", dir: "desc" } }),
      null,
    );
    expect(desc.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by match percentage using the match map", () => {
    const matches = new Map([
      ["a", 40],
      ["b", 95],
      ["c", 70],
    ]);
    const best = visiblePaneFlows(
      FLOWS,
      query({ sort: { columnId: "match", dir: "desc" } }),
      matches,
    );
    expect(best.map((f) => f.id)).toEqual(["b", "c", "a"]);
  });
});

describe("pane selection", () => {
  const ids = ["a", "b", "c"];

  it("selects a single row on plain click", () => {
    const sel = selectRow(selectOnly(null), ids, "b", "single");
    expect([...sel.selectedIds]).toEqual(["b"]);
    expect(sel.focusedId).toBe("b");
    expect(sel.anchorId).toBe("b");
  });

  it("toggles rows with ctrl semantics", () => {
    const sel = selectRow(selectOnly("a"), ids, "c", "toggle");
    expect([...sel.selectedIds].sort()).toEqual(["a", "c"]);
    const shrunk = selectRow(sel, ids, "c", "toggle");
    expect([...shrunk.selectedIds]).toEqual(["a"]);
  });

  it("ranges from the anchor with shift semantics", () => {
    const sel = selectRow(selectOnly("a"), ids, "c", "range");
    expect([...sel.selectedIds].sort()).toEqual(["a", "b", "c"]);
    expect(sel.focusedId).toBe("c");
    expect(sel.anchorId).toBe("a");
  });

  it("falls back to a single selection when the anchor left the visible list", () => {
    const sel = selectRow(
      { selectedIds: new Set(["gone"]), focusedId: "gone", anchorId: "gone" },
      ids,
      "b",
      "range",
    );
    expect([...sel.selectedIds]).toEqual(["b"]);
  });

  it("steps the focus and collapses the selection, or extends it with shift", () => {
    const start = selectOnly("a");
    const stepped = stepSelection(start, ids, 1, false);
    expect(stepped.focusedId).toBe("b");
    expect([...stepped.selectedIds]).toEqual(["b"]);
    const extended = stepSelection(stepped, ids, 1, true);
    expect([...extended.selectedIds].sort()).toEqual(["b", "c"]);
    expect(extended.anchorId).toBe("b");
  });

  it("clamps stepping at the ends", () => {
    const top = stepSelection(selectOnly("a"), ids, -1, false);
    expect(top.focusedId).toBe("a");
  });
});

describe("moving rows across panes", () => {
  it("extracts by id keeping order and suggests the next focus", () => {
    const extraction = extractFlows(FLOWS, new Set(["a", "c"]));
    expect(extraction?.moved.map((f) => f.id)).toEqual(["a", "c"]);
    expect(extraction?.rest.map((f) => f.id)).toEqual(["b"]);
    expect(extraction?.nextFocus).toBe("b");
  });

  it("returns null when nothing matches", () => {
    expect(extractFlows(FLOWS, new Set(["nope"]))).toBeNull();
  });

  it("moves the visible selection across and selects it at the destination", () => {
    const from = { ...paneData(FLOWS), sel: selectMany(["a", "c"]) };
    const to = paneData([]);
    const moved = movePaneFlows(from, to, ["a", "b", "c"], null);
    expect(moved?.from.flows.map((f) => f.id)).toEqual(["b"]);
    expect(moved?.from.sel.focusedId).toBe("b");
    expect(moved?.to.flows.map((f) => f.id)).toEqual(["a", "c"]);
    expect([...(moved?.to.sel.selectedIds ?? [])].sort()).toEqual(["a", "c"]);
  });

  it("moves only rows that are visible in the source pane", () => {
    const from = { ...paneData(FLOWS), sel: selectMany(["a", "c"]) };
    const moved = movePaneFlows(from, paneData([]), ["a", "b"], null);
    expect(moved?.to.flows.map((f) => f.id)).toEqual(["a"]);
    expect(moved?.from.flows.map((f) => f.id)).toEqual(["b", "c"]);
  });
});
