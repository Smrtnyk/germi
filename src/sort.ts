import type { ColumnDef } from "./columns";
import type { FlowSummary } from "./types";

export type SortDir = "asc" | "desc";

export interface SortState {
  columnId: string;
  dir: SortDir;
}

type SortValue = string | number | null;

export function nextSort(prev: SortState | null, columnId: string): SortState | null {
  if (!prev || prev.columnId !== columnId) return { columnId, dir: "asc" };
  if (prev.dir === "asc") return { columnId, dir: "desc" };
  return null;
}

export function resolveSort(sort: SortState | null, columns: ColumnDef[]): SortState | null {
  if (!sort) return null;
  return columns.some((c) => c.id === sort.columnId && c.sortKey) ? sort : null;
}

function isEmpty(v: SortValue): boolean {
  return v == null || v === "";
}

function compare(a: SortValue, b: SortValue, sign: number): number {
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty || bEmpty) {
    if (aEmpty && bEmpty) return 0;
    return aEmpty ? 1 : -1;
  }
  if (typeof a === "number" && typeof b === "number") return sign * (a - b);
  return sign * String(a).localeCompare(String(b));
}

export function sortFlows(
  flows: FlowSummary[],
  sort: SortState | null,
  columns: ColumnDef[],
): FlowSummary[] {
  if (!sort) return flows;
  const col = columns.find((c) => c.id === sort.columnId);
  if (!col?.sortKey) return flows;
  const key = col.sortKey;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...flows].sort((fa, fb) => compare(key(fa), key(fb), sign));
}
