import { describe, expect, it } from "vitest";
import { allColumns, DEFAULT_COLUMNS, PRESETS, resolveColumns, type ColumnDef } from "./columns";
import type { FlowSummary } from "./types";

function summary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
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
    extra: {},
    ...overrides,
  };
}

function textOf(id: string, s: FlowSummary, headerSpecs: string[] = []): string {
  const col = allColumns(headerSpecs).find((c) => c.id === id);
  if (!col) throw new Error(`no column ${id}`);
  return col.text(s);
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

describe("presets", () => {
  it("defaults to the Default preset's columns", () => {
    expect(PRESETS[1].name).toBe("Default");
    expect(DEFAULT_COLUMNS).toBe(PRESETS[1].columns);
    expect(DEFAULT_COLUMNS).toContain("method");
  });
});
