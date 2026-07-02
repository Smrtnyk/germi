type ModifierKeys = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">;

function mainKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

export function accelFromKeyboardEvent(e: ModifierKeys): string | null {
  const mods: string[] = [];
  // Require Ctrl/Alt/Win as the primary modifier — Shift alone isn't a real
  // global-hotkey modifier (it just types a capital letter) and desktops reject it.
  const hasPrimary = e.ctrlKey || e.metaKey || e.altKey;
  if (e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.metaKey) mods.push("Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = mainKeyFromCode(e.code);
  if (!key || !hasPrimary) return null;
  return [...mods, key].join("+");
}

export function prettyAccel(accel: string): string {
  return accel.replace(/CmdOrCtrl/g, "Ctrl").replace(/Super/g, "Win");
}

/** Whether a key event originates from a text-entry element, so window-level
 *  key handling can stay out of the way of typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
