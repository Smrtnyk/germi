export const FLOW_DRAG_MIME = "application/x-germi-flows";
export const RULE_DRAG_MIME = "application/x-germi-rule";
export const COLOR_DRAG_MIME = "application/x-germi-color";

/** Capture formats we accept as a drag-dropped file (issue #100), matching the
 *  native picker's filter — HAR and Fiddler SAZ. */
const CAPTURE_EXTS = ["har", "saz"] as const;
export type CaptureExt = (typeof CAPTURE_EXTS)[number];

/** A drag carrying OS files (vs. an in-app flow / rule / color drag). The
 *  browser exposes `"Files"` in `dataTransfer.types` for filesystem drags; the
 *  in-app drags carry only their custom MIME (+ `text/plain`), so this cleanly
 *  separates a capture-file drop from the row/swatch drags on the same window. */
export function hasFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** The capture format of a dropped file by its name, or `null` if it isn't one
 *  we can load. Case-insensitive; the extension tells the engine whether to
 *  parse a HAR or a SAZ. */
export function captureExtFromName(name: string): CaptureExt | null {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (CAPTURE_EXTS as readonly string[]).includes(ext) ? (ext as CaptureExt) : null;
}

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
