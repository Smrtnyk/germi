export function nextIdAfterDelete(
  order: string[],
  deletedIds: Set<string>,
  focusedId: string | null,
): string | null {
  if (order.length === 0) return null;
  const focusedIdx = focusedId !== null ? order.indexOf(focusedId) : -1;
  if (focusedIdx >= 0 && !deletedIds.has(order[focusedIdx])) return order[focusedIdx];
  if (focusedIdx >= 0) {
    for (let i = focusedIdx + 1; i < order.length; i++) {
      if (!deletedIds.has(order[i])) return order[i];
    }
  }
  for (let i = focusedIdx >= 0 ? focusedIdx - 1 : order.length - 1; i >= 0; i--) {
    if (!deletedIds.has(order[i])) return order[i];
  }
  return null;
}

/** A copy of `prev` with `item` toggled in or out. */
export function toggledSet<T>(prev: Set<T>, item: T): Set<T> {
  const next = new Set(prev);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

/** All ids between `anchor` and `id` (inclusive) in display order, or null when
 *  either end is gone (the caller re-anchors). */
export function rangeSelection(ids: string[], anchor: string, id: string): Set<string> | null {
  const a = ids.indexOf(anchor);
  const b = ids.indexOf(id);
  if (a === -1 || b === -1) return null;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(ids.slice(lo, hi + 1));
}

export interface SelectionPatch {
  selectedIds: Set<string>;
  selectedId: string | null;
  anchor: string | null;
}

function lastSelectedId(order: string[], selected: Set<string>): string | null {
  for (let i = order.length - 1; i >= 0; i--) {
    if (selected.has(order[i])) return order[i];
  }
  return null;
}

export function toggleSelection(
  order: string[],
  selectedIds: Set<string>,
  selectedId: string | null,
  id: string,
): SelectionPatch {
  const selected = new Set(selectedIds);
  if (selected.has(id)) {
    selected.delete(id);
    const focus = selectedId === id ? lastSelectedId(order, selected) : selectedId;
    return { selectedIds: selected, selectedId: focus, anchor: id };
  }
  selected.add(id);
  return { selectedIds: selected, selectedId: id, anchor: id };
}
