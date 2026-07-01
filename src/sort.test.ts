import { describe, expect, it } from "vitest";
import { allColumns, type ColumnDef } from "./columns";
import { nextSort, resolveSort, sortFlows, type SortState } from "./sort";
import type { AvailabilityVerdict, FlowSummary } from "./types";

function summary(id: string, overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id,
    seq: 0,
    method: "GET",
    host: "example.com",
    path: "/",
    scheme: "https",
    status: 200,
    mime: "application/json",
    kind: "xhr",
    reqSize: 0,
    respSize: 0,
    durationMs: null,
    ttfbMs: null,
    matchedRule: null,
    timestampMs: 0,
    comment: null,
    availability: null,
    imported: false,
    extra: {},
    ...overrides,
  };
}

const COLUMNS = allColumns([]);

function ids(flows: FlowSummary[]): string[] {
  return flows.map((f) => f.id);
}

function sortBy(flows: FlowSummary[], columnId: string, dir: "asc" | "desc"): string[] {
  return ids(sortFlows(flows, { columnId, dir }, COLUMNS));
}

describe("nextSort", () => {
  it("starts a fresh column ascending", () => {
    expect(nextSort(null, "host")).toEqual({ columnId: "host", dir: "asc" });
    expect(nextSort({ columnId: "status", dir: "asc" }, "host")).toEqual({
      columnId: "host",
      dir: "asc",
    });
  });

  it("cycles asc → desc → off on the same column", () => {
    const asc: SortState = { columnId: "host", dir: "asc" };
    const desc = nextSort(asc, "host");
    expect(desc).toEqual({ columnId: "host", dir: "desc" });
    expect(nextSort(desc, "host")).toBeNull();
  });
});

describe("resolveSort", () => {
  it("is null when there is no sort", () => {
    expect(resolveSort(null, COLUMNS)).toBeNull();
  });

  it("keeps a sort whose column is present and sortable", () => {
    const sort: SortState = { columnId: "status", dir: "asc" };
    expect(resolveSort(sort, COLUMNS)).toBe(sort);
  });

  it("drops a sort whose column is absent from the visible set", () => {
    const visible = COLUMNS.filter((c) => c.id !== "availability");
    expect(resolveSort({ columnId: "availability", dir: "asc" }, visible)).toBeNull();
  });

  it("drops a sort whose column has no sort key", () => {
    const unsortable: ColumnDef[] = [{ id: "x", label: "X", width: 10, text: () => "" }];
    expect(resolveSort({ columnId: "x", dir: "asc" }, unsortable)).toBeNull();
  });
});

describe("sortFlows", () => {
  it("returns the input untouched when there is no sort", () => {
    const flows = [summary("a"), summary("b")];
    expect(sortFlows(flows, null, COLUMNS)).toBe(flows);
  });

  it("does not mutate the input array", () => {
    const flows = [summary("a", { respSize: 30 }), summary("b", { respSize: 10 })];
    const before = ids(flows);
    sortFlows(flows, { columnId: "respSize", dir: "asc" }, COLUMNS);
    expect(ids(flows)).toEqual(before);
  });

  it("restores capture order when sorting by the request number", () => {
    // Shuffled rows (as if sorted by another column) recover arrival order via "#".
    const flows = [summary("c", { seq: 3 }), summary("a", { seq: 1 }), summary("b", { seq: 2 })];
    expect(sortBy(flows, "seq", "asc")).toEqual(["a", "b", "c"]);
    expect(sortBy(flows, "seq", "desc")).toEqual(["c", "b", "a"]);
  });

  it("orders numbers ascending and descending", () => {
    const flows = [
      summary("a", { respSize: 30 }),
      summary("b", { respSize: 10 }),
      summary("c", { respSize: 20 }),
    ];
    expect(sortBy(flows, "respSize", "asc")).toEqual(["b", "c", "a"]);
    expect(sortBy(flows, "respSize", "desc")).toEqual(["a", "c", "b"]);
  });

  it("keeps missing numeric values last regardless of direction", () => {
    const flows = [
      summary("a", { status: 200 }),
      summary("pending", { status: null }),
      summary("b", { status: 404 }),
    ];
    expect(sortBy(flows, "status", "asc")).toEqual(["a", "b", "pending"]);
    expect(sortBy(flows, "status", "desc")).toEqual(["b", "a", "pending"]);
  });

  it("keeps blank strings last regardless of direction", () => {
    const flows = [
      summary("a", { comment: "zebra" }),
      summary("blank", { comment: null }),
      summary("b", { comment: "apple" }),
    ];
    expect(sortBy(flows, "comment", "asc")).toEqual(["b", "a", "blank"]);
    expect(sortBy(flows, "comment", "desc")).toEqual(["a", "b", "blank"]);
  });

  it("orders strings case-insensitively", () => {
    const flows = [
      summary("a", { host: "Beta.com" }),
      summary("b", { host: "alpha.com" }),
      summary("c", { host: "gamma.com" }),
    ];
    expect(sortBy(flows, "host", "asc")).toEqual(["b", "a", "c"]);
  });

  function avail(verdict: AvailabilityVerdict): FlowSummary["availability"] {
    return { verdict, status: null, location: null };
  }

  it("orders availability by verdict severity with unchecked last", () => {
    const flows = [
      summary("err", { availability: avail("error") }),
      summary("pub", { availability: avail("public") }),
      summary("unchecked", { availability: null }),
      summary("prot", { availability: avail("protected") }),
    ];
    expect(sortBy(flows, "availability", "asc")).toEqual(["pub", "prot", "err", "unchecked"]);
    expect(sortBy(flows, "availability", "desc")).toEqual(["err", "prot", "pub", "unchecked"]);
  });

  it("preserves input order for ties (stable)", () => {
    const flows = [
      summary("a", { respSize: 10 }),
      summary("b", { respSize: 10 }),
      summary("c", { respSize: 10 }),
    ];
    expect(sortBy(flows, "respSize", "asc")).toEqual(["a", "b", "c"]);
    expect(sortBy(flows, "respSize", "desc")).toEqual(["a", "b", "c"]);
  });

  it("passes through when the column is unknown or not sortable", () => {
    const flows = [summary("a", { respSize: 30 }), summary("b", { respSize: 10 })];
    expect(sortFlows(flows, { columnId: "nope", dir: "asc" }, COLUMNS)).toBe(flows);
    const unsortable: ColumnDef[] = [{ id: "x", label: "X", width: 10, text: () => "" }];
    expect(sortFlows(flows, { columnId: "x", dir: "asc" }, unsortable)).toBe(flows);
  });
});
