import { describe, expect, it } from "vitest";
import {
  allColumns,
  backfillSeqColumn,
  DEFAULT_COLUMNS,
  PRESETS,
  resolveColumns,
  type ColumnDef,
} from "./columns";
import type { FlowSummary } from "./types";

function summary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
    seq: 1,
    method: "GET",
    host: "example.com",
    path: "/api/users?page=2",
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

function textOf(id: string, s: FlowSummary, headerSpecs: string[] = []): string {
  const col = allColumns(headerSpecs).find((c) => c.id === id);
  if (!col) throw new Error(`no column ${id}`);
  return col.text(s);
}

function sortKeyOf(
  id: string,
  s: FlowSummary,
  headerSpecs: string[] = [],
): string | number | null | undefined {
  const col = allColumns(headerSpecs).find((c) => c.id === id);
  if (!col) throw new Error(`no column ${id}`);
  return col.sortKey?.(s);
}

describe("allColumns", () => {
  it("exposes the built-in columns", () => {
    const ids = allColumns([]).map((c) => c.id);
    expect(ids).toContain("method");
    expect(ids).toContain("status");
    expect(ids).toContain("comment");
  });

  it("appends a column per pinned header spec", () => {
    const byId = new Map(allColumns(["cf-ray", "req:referer"]).map((c) => [c.id, c]));
    expect(byId.get("hdr:cf-ray")?.label).toBe("cf-ray");
    expect(byId.get("hdr:req:referer")?.label).toBe("referer (req)");
  });

  it("reads header-column text from the flow's extra map", () => {
    expect(textOf("hdr:cf-ray", summary({ extra: { "cf-ray": "abc123" } }), ["cf-ray"])).toBe(
      "abc123",
    );
    expect(textOf("hdr:cf-ray", summary(), ["cf-ray"])).toBe("");
  });
});

describe("column text rendering", () => {
  it("renders url, query and method", () => {
    const s = summary();
    expect(textOf("url", s)).toBe("https://example.com/api/users?page=2");
    expect(textOf("query", s)).toBe("?page=2");
    expect(textOf("method", s)).toBe("GET");
  });

  it("renders the request number and sorts by it numerically", () => {
    expect(textOf("seq", summary({ seq: 42 }))).toBe("42");
    expect(sortKeyOf("seq", summary({ seq: 42 }))).toBe(42);
  });

  it("shows a non-numeric placeholder for an in-flight status", () => {
    expect(textOf("status", summary({ status: null }))).not.toMatch(/\d/);
    expect(textOf("status", summary({ status: 200 }))).toBe("200");
  });

  it("formats sizes with units and blanks a zero", () => {
    expect(textOf("respSize", summary({ respSize: 0 }))).toBe("");
    expect(textOf("respSize", summary({ respSize: 500 }))).toBe("500 B");
    expect(textOf("respSize", summary({ respSize: 2048 }))).toBe("2.0 KB");
    expect(textOf("totalSize", summary({ reqSize: 1024, respSize: 1024 }))).toBe("2.0 KB");
  });

  it("renders durations as plain milliseconds or blank", () => {
    expect(textOf("duration", summary({ durationMs: 123 }))).toBe("123");
    expect(textOf("duration", summary({ durationMs: null }))).toBe("");
  });

  it("labels the origin column only for imported flows", () => {
    expect(textOf("origin", summary({ imported: true }))).toBe("imported");
    expect(textOf("origin", summary({ imported: false }))).toBe("");
  });
});

describe("availability column", () => {
  it("words the verdict for a checked flow and blanks an unchecked one", () => {
    const checked = summary({ availability: { verdict: "public", status: 200, location: null } });
    expect(textOf("availability", checked)).toBe("Reachable");
    expect(textOf("availability", summary())).toBe("");
  });

  it("sorts by verdict severity, null for unchecked", () => {
    expect(
      sortKeyOf(
        "availability",
        summary({ availability: { verdict: "public", status: 200, location: null } }),
      ),
    ).toBe(0);
    expect(
      sortKeyOf(
        "availability",
        summary({ availability: { verdict: "error", status: null, location: null } }),
      ),
    ).toBe(3);
    expect(sortKeyOf("availability", summary())).toBeNull();
  });
});

describe("sort keys", () => {
  it("exposes a sort key on every built-in and pinned header column", () => {
    for (const c of allColumns(["cf-ray"])) {
      expect(typeof c.sortKey).toBe("function");
    }
  });

  it("reads raw numeric and string values rather than formatted text", () => {
    expect(sortKeyOf("respSize", summary({ respSize: 2048 }))).toBe(2048);
    expect(sortKeyOf("status", summary({ status: null }))).toBeNull();
    expect(sortKeyOf("origin", summary({ imported: true }))).toBe(1);
    expect(sortKeyOf("origin", summary({ imported: false }))).toBe(0);
    expect(sortKeyOf("hdr:cf-ray", summary({ extra: { "cf-ray": "abc" } }), ["cf-ray"])).toBe(
      "abc",
    );
  });
});

describe("resolveColumns", () => {
  it("maps ids to definitions in order, dropping unknown ids", () => {
    const cols: ColumnDef[] = resolveColumns(["status", "nope", "method"], []);
    expect(cols.map((c) => c.id)).toEqual(["status", "method"]);
  });

  it("resolves pinned header columns and drops unconfigured ones", () => {
    expect(resolveColumns(["hdr:cf-ray", "method"], ["cf-ray"]).map((c) => c.id)).toEqual([
      "hdr:cf-ray",
      "method",
    ]);
    expect(resolveColumns(["hdr:cf-ray"], []).map((c) => c.id)).toEqual([]);
  });
});

describe("backfillSeqColumn", () => {
  it("prepends the request-number column to an order saved before it existed", () => {
    expect(backfillSeqColumn(["method", "status"], false)).toEqual(["seq", "method", "status"]);
  });

  it("leaves an order that already has the column untouched", () => {
    expect(backfillSeqColumn(["seq", "method"], false)).toEqual(["seq", "method"]);
  });

  it("does not re-add the column once the one-time backfill has run", () => {
    // A user who deliberately removed "#" must keep it removed across reloads.
    expect(backfillSeqColumn(["method", "status"], true)).toEqual(["method", "status"]);
  });
});

describe("presets", () => {
  it("defaults to the Default preset's columns", () => {
    expect(PRESETS[1].name).toBe("Default");
    expect(DEFAULT_COLUMNS).toBe(PRESETS[1].columns);
    expect(DEFAULT_COLUMNS).toContain("method");
  });

  it("leads every preset with the request-number column", () => {
    for (const preset of PRESETS) {
      expect(preset.columns[0]).toBe("seq");
    }
  });
});
