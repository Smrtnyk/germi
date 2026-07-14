import { describe, expect, it } from "vitest";

import {
  appendPaneFlows,
  copyPaneFilter,
  emptyPaneQuery,
  extractFlows,
  hasPaneFilter,
  linkSourceSide,
  movePaneFlows,
  paneData,
  retainVisibleSelection,
  selectAll,
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

describe("filter linking", () => {
  it("counts text and kind chips as filter state but never the sort", () => {
    expect(hasPaneFilter(query())).toBe(false);
    expect(hasPaneFilter(query({ filter: "   " }))).toBe(false);
    expect(hasPaneFilter(query({ filter: "host:api" }))).toBe(true);
    expect(hasPaneFilter(query({ kinds: new Set<ResourceKind>(["js"]) }))).toBe(true);
    expect(hasPaneFilter(query({ sort: { columnId: "status", dir: "asc" } }))).toBe(false);
  });

  it("copies the text and kinds onto the target but keeps the target's sort", () => {
    const source = query({ filter: "host:api", kinds: new Set<ResourceKind>(["xhr"]) });
    const target = query({ filter: "old", sort: { columnId: "seq", dir: "desc" } });
    const copied = copyPaneFilter(source, target);
    expect(copied.filter).toBe("host:api");
    expect([...copied.kinds]).toEqual(["xhr"]);
    expect(copied.sort).toEqual({ columnId: "seq", dir: "desc" });
    expect(copied.kinds).not.toBe(source.kinds);
  });

  it("relinks from the only side that has a filter", () => {
    expect(linkSourceSide(query(), query({ filter: "cdn" }))).toBe("right");
    expect(linkSourceSide(query({ kinds: new Set<ResourceKind>(["js"]) }), query())).toBe("left");
  });

  it("prefers the left side when both (or neither) have a filter", () => {
    expect(linkSourceSide(query({ filter: "a" }), query({ filter: "b" }))).toBe("left");
    expect(linkSourceSide(query(), query())).toBe("left");
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

  it("selects every row on select-all, focusing the last and anchoring the first", () => {
    const sel = selectAll(selectOnly("b"), ids);
    expect([...sel.selectedIds]).toEqual(["a", "b", "c"]);
    expect(sel.focusedId).toBe("c");
    expect(sel.anchorId).toBe("a");
  });

  it("leaves the selection untouched when select-all runs on an empty list", () => {
    const before = selectOnly("b");
    expect(selectAll(before, [])).toBe(before);
  });

  it("moves focus to a visible selected row when a filter hides the focused row", () => {
    const retained = retainVisibleSelection(
      { selectedIds: new Set(["a", "c"]), focusedId: "c", anchorId: "a" },
      ["a", "b"],
    );
    expect([...retained.selectedIds]).toEqual(["a"]);
    expect(retained.focusedId).toBe("a");
    expect(retained.anchorId).toBe("a");
  });

  it("selects the first visible row or clears when no filtered rows remain", () => {
    expect(retainVisibleSelection(selectOnly("c"), ["a", "b"])).toEqual(selectOnly("a"));
    expect(retainVisibleSelection(selectOnly("c"), [])).toEqual(selectOnly(null));
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

  it("focuses the next visible row after a move instead of a filtered-out neighbor", () => {
    const from = paneData(FLOWS);
    const moved = movePaneFlows(from, paneData([]), ["a", "c"], null);

    expect(moved?.to.flows.map((f) => f.id)).toEqual(["a"]);
    expect(moved?.from.sel).toEqual(selectOnly("c"));
  });

  it("does not select arrivals hidden by the destination filter", () => {
    const to = {
      ...paneData([FLOWS[0]]),
      query: query({ filter: "host:api.test" }),
    };
    const moved = movePaneFlows(paneData([FLOWS[1]]), to, ["b"], null);

    expect(moved?.to.flows.map((flow) => flow.id)).toEqual(["a", "b"]);
    expect(moved?.to.sel).toEqual(selectOnly("a"));
  });
});

describe("appending rows", () => {
  it("leaves a filtered-empty pane unfocused when imported rows stay hidden", () => {
    const pane = {
      ...paneData([]),
      query: query({ filter: "host:api.test" }),
    };

    const appended = appendPaneFlows(pane, [FLOWS[1]], null);
    expect(appended.flows.map((flow) => flow.id)).toEqual(["b"]);
    expect(appended.sel).toEqual(selectOnly(null));
  });
});
