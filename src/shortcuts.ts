// The IN-APP keyboard-shortcut model: the grammar for shortcuts dispatched by
// the window keydown handler in App.tsx. This is deliberately NOT the Tauri/OS
// global-hotkey grammar in `hotkey.ts` (`CmdOrCtrl`/`Super`):
//   - "Mod" collapses Ctrl and ⌘ into a single modifier, because the app treats
//     `metaKey || ctrlKey` as one and these fire inside the focused window.
//   - A bare function key (e.g. F2) is a valid binding; `hotkey.ts` requires a
//     real modifier because desktops reject bare-key *global* hotkeys.
// Accel grammar: parts joined by "+", in fixed order Mod, Alt, Shift, <KEY>,
// where <KEY> is X (KeyX), N (DigitN), or F1..F24. e.g. "Mod+K", "Mod+1",
// "Mod+Shift+Z", "F2".

type ModifierKeys = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">;

export type CommandId =
  | "palette"
  | "focus-filter"
  | "save"
  | "open"
  | "copy-url"
  | "show-inspector"
  | "show-autoresponder"
  | "edit-mock-body";

export type Accel = string;

export interface ShortcutCommand {
  id: CommandId;
  label: string;
  default: Accel;
}

// Single source of truth; array order is the display order in Settings + help.
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: "palette", label: "Open command palette", default: "Mod+K" },
  { id: "focus-filter", label: "Find in request / focus filter", default: "Mod+F" },
  { id: "save", label: "Save session", default: "Mod+S" },
  { id: "open", label: "Open session", default: "Mod+O" },
  { id: "copy-url", label: "Copy URL of selected request", default: "Mod+U" },
  { id: "show-inspector", label: "Show Inspector", default: "Mod+1" },
  { id: "show-autoresponder", label: "Show Autoresponder", default: "Mod+2" },
  { id: "edit-mock-body", label: "Edit mock response body", default: "F2" },
];

export type Bindings = Record<CommandId, Accel>;

export const DEFAULT_SHORTCUTS: Bindings = Object.fromEntries(
  SHORTCUT_COMMANDS.map((c) => [c.id, c.default]),
) as Bindings;

const COMMAND_IDS: readonly CommandId[] = SHORTCUT_COMMANDS.map((c) => c.id);

// Accels a binding may NOT take: the combos with fixed in-app behavior
// (select-all / undo / redo, handled in App.tsx) and the native clipboard keys —
// so a custom binding can never shadow copy / paste / cut / select-all / undo.
const RESERVED_ACCELS: ReadonlySet<Accel> = new Set([
  "Mod+A",
  "Mod+Z",
  "Mod+Y",
  "Mod+Shift+Z",
  "Mod+Shift+Y",
  "Mod+C",
  "Mod+V",
  "Mod+X",
]);

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

function mainKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (FUNCTION_KEY.test(code)) return code;
  return null;
}

/**
 * A window-keydown event → its canonical in-app accel, or null when the combo
 * isn't bindable. Bindable = it has Ctrl/Alt/Meta, OR it's a bare function key;
 * bare letters/digits and unsupported keys return null so a binding can never
 * swallow ordinary typing.
 */
export function accelFromEvent(e: ModifierKeys): Accel | null {
  const key = mainKeyFromCode(e.code);
  if (!key) return null;
  const hasPrimary = e.ctrlKey || e.metaKey || e.altKey;
  if (!hasPrimary && !FUNCTION_KEY.test(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const PRETTY: Record<string, string> = {
  Mod: "Ctrl / ⌘",
  Alt: "Alt",
  Shift: "Shift",
};

/** Human label for an accel, matching the help table's style. "Mod+K" → "Ctrl / ⌘ K". */
export function prettyShortcut(accel: Accel): string {
  return accel
    .split("+")
    .map((p) => PRETTY[p] ?? p)
    .join(" ");
}

function isCommandId(id: string): id is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(id);
}

/**
 * Merge user overrides over the defaults, ignoring unknown ids and non-string
 * values — tolerant of hand-edited / version-skewed localStorage (like
 * `loadColumnOrder`). A command missing from the overrides keeps its default.
 */
export function resolveBindings(overrides: unknown): Bindings {
  const out: Bindings = { ...DEFAULT_SHORTCUTS };
  if (overrides && typeof overrides === "object") {
    for (const [id, accel] of Object.entries(overrides as Record<string, unknown>)) {
      if (isCommandId(id) && typeof accel === "string" && accel) out[id] = accel;
    }
  }
  return out;
}

/** accel → commandId index for O(1) dispatch. */
export function reverseLookup(bindings: Bindings): Map<Accel, CommandId> {
  const map = new Map<Accel, CommandId>();
  for (const id of COMMAND_IDS) map.set(bindings[id], id);
  return map;
}

export type Conflict = { kind: "command"; id: CommandId } | { kind: "reserved" };

/**
 * Whether `accel` is free to assign to `exceptId`: returns the command already
 * using it, a reserved-key flag, or null when it's free.
 */
export function findConflict(
  bindings: Bindings,
  accel: Accel,
  exceptId: CommandId,
): Conflict | null {
  if (RESERVED_ACCELS.has(accel)) return { kind: "reserved" };
  for (const id of COMMAND_IDS) {
    if (id !== exceptId && bindings[id] === accel) return { kind: "command", id };
  }
  return null;
}
