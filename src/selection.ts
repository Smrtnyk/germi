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
