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
