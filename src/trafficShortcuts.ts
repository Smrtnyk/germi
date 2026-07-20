type ClearShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "preventDefault"
>;

export function isClearTrafficShortcut(
  event: ClearShortcutEvent,
  withinTrafficList: boolean,
): boolean {
  return (
    withinTrafficList &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "x"
  );
}

export function handleClearTrafficShortcut(
  event: ClearShortcutEvent,
  withinTrafficList: boolean,
  clearTraffic: () => void,
): boolean {
  if (!isClearTrafficShortcut(event, withinTrafficList)) return false;
  event.preventDefault();
  clearTraffic();
  return true;
}
