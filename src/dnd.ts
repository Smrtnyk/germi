export const FLOW_DRAG_MIME = "application/x-germi-flows";
export const RULE_DRAG_MIME = "application/x-germi-rule";
export const COLOR_DRAG_MIME = "application/x-germi-color";

export function dragFlowIds(
  rowId: string,
  selectedIds: Set<string>,
  orderedIds: string[],
): string[] {
  if (selectedIds.size > 1 && selectedIds.has(rowId)) {
    const ids = orderedIds.filter((id) => selectedIds.has(id));
    return ids.length > 0 ? ids : [rowId];
  }
  return [rowId];
}

export function encodeFlowIds(ids: string[]): string {
  return JSON.stringify(ids);
}

export function decodeFlowIds(data: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
    ? (parsed as string[])
    : [];
}

export function hasFlowDrag(types: readonly string[]): boolean {
  return types.includes(FLOW_DRAG_MIME);
}

/** A color swatch drag (in-app), or plain text that may hold a pasted hex
 *  (e.g. dropped from an external color tool) — parsing decides on drop. */
export function hasColorDrag(types: readonly string[]): boolean {
  return types.includes(COLOR_DRAG_MIME) || types.includes("text/plain");
}
