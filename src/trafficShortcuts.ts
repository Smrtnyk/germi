type ClearShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
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
