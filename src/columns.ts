import type { FlowSummary } from "./types";

// The traffic-list column model. Built-in columns plus user-pinned header
// columns (id `hdr:<spec>`) are resolved into an ordered, visible list driven by
// `columnOrder` (persisted UI state) + `settings.headerColumns` (backend-pinned).

export type ColAlign = "left" | "right";
export type SpecialCell = "method" | "status" | "kind" | "comment";

export interface ColumnDef {
  id: string;
  label: string;
  width: number;
  align?: ColAlign;
  /** Cells needing bespoke rendering (color/chip/editable) — handled in TrafficList. */
  special?: SpecialCell;
  /** Plain display value for ordinary cells. */
  text: (f: FlowSummary) => string;
}

function fmtSize(n: number): string {
  if (n === 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtMs(n: number | null): string {
  return n == null ? "" : `${n}`;
}
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}
function queryOf(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? "" : path.slice(q);
}

const BUILTIN_COLUMNS: ColumnDef[] = [
  { id: "method", label: "Method", width: 62, special: "method", text: (f) => f.method },
  { id: "host", label: "Host", width: 150, text: (f) => f.host },
  { id: "path", label: "Path", width: 240, text: (f) => f.path },
  {
    id: "url",
    label: "URL",
    width: 320,
    text: (f) => `${f.scheme}://${f.host}${f.path}`,
  },
  { id: "query", label: "Query", width: 150, text: (f) => queryOf(f.path) },
  { id: "scheme", label: "Scheme", width: 64, text: (f) => f.scheme },
  {
    id: "status",
    label: "Status",
    width: 64,
    special: "status",
    text: (f) => (f.status == null ? "···" : `${f.status}`),
  },
  { id: "type", label: "Type", width: 116, text: (f) => f.mime ?? "" },
  { id: "kind", label: "Kind", width: 78, special: "kind", text: (f) => f.kind },
  { id: "reqSize", label: "Req size", width: 78, align: "right", text: (f) => fmtSize(f.reqSize) },
  { id: "respSize", label: "Size", width: 78, align: "right", text: (f) => fmtSize(f.respSize) },
  {
    id: "totalSize",
    label: "Total",
    width: 80,
    align: "right",
    text: (f) => fmtSize(f.reqSize + f.respSize),
  },
  { id: "start", label: "Start", width: 96, align: "right", text: (f) => fmtClock(f.timestampMs) },
  { id: "ttfb", label: "TTFB", width: 58, align: "right", text: (f) => fmtMs(f.ttfbMs) },
  { id: "duration", label: "Time", width: 56, align: "right", text: (f) => fmtMs(f.durationMs) },
  {
    id: "download",
    label: "Download",
    width: 78,
    align: "right",
    text: (f) =>
      f.durationMs != null && f.ttfbMs != null ? `${Math.max(0, f.durationMs - f.ttfbMs)}` : "",
  },
  { id: "rule", label: "Mocked by", width: 150, text: (f) => f.matchedRule ?? "" },
  { id: "comment", label: "Comment", width: 170, special: "comment", text: (f) => f.comment ?? "" },
];

export const PRESETS: { name: string; columns: string[] }[] = [
  { name: "Minimal", columns: ["method", "host", "path", "status", "respSize"] },
  {
    name: "Default",
    columns: ["method", "host", "path", "status", "type", "respSize", "duration", "comment"],
  },
  {
    name: "Timing",
    columns: ["method", "path", "status", "start", "ttfb", "duration", "download"],
  },
  {
    name: "Sizes",
    columns: ["method", "path", "status", "reqSize", "respSize", "totalSize", "type"],
  },
  { name: "Mocking", columns: ["method", "host", "path", "status", "rule", "comment"] },
];

export const DEFAULT_COLUMNS = PRESETS[1].columns;

function headerColumnDef(spec: string): ColumnDef {
  const isReq = spec.startsWith("req:");
  const name = isReq ? spec.slice(4) : spec;
  return {
    id: `hdr:${spec}`,
    label: isReq ? `${name} (req)` : name,
    width: 130,
    text: (f) => f.extra?.[spec] ?? "",
  };
}

/** Every selectable column: built-ins + the user's pinned header columns. */
export function allColumns(headerSpecs: string[]): ColumnDef[] {
  return [...BUILTIN_COLUMNS, ...headerSpecs.map(headerColumnDef)];
}

/** Resolve an ordered list of column ids into definitions (dropping unknowns). */
export function resolveColumns(order: string[], headerSpecs: string[]): ColumnDef[] {
  const byId = new Map(allColumns(headerSpecs).map((c) => [c.id, c]));
  return order.map((id) => byId.get(id)).filter((c): c is ColumnDef => Boolean(c));
}
