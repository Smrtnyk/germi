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
  | "create-filter"
  | "toggle-filter-hide"
  | "save"
  | "open"
  | "copy-url"
  | "show-inspector"
  | "show-autoresponder"
  | "show-filters"
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
  { id: "create-filter", label: "Create saved filter", default: "Mod+Shift+F" },
  { id: "toggle-filter-hide", label: "Hide / dim non-matching requests", default: "Mod+H" },
  { id: "save", label: "Save session", default: "Mod+S" },
  { id: "open", label: "Open session", default: "Mod+O" },
  { id: "copy-url", label: "Copy URL of selected request", default: "Mod+U" },
  { id: "show-inspector", label: "Show Inspector", default: "Mod+1" },
  { id: "show-autoresponder", label: "Show Autoresponder", default: "Mod+2" },
  { id: "show-filters", label: "Show saved Filters", default: "Mod+3" },
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
  if (!accel) return "";
  return accel
    .split("+")
    .map((p) => PRETTY[p] ?? p)
    .join(" ");
}

function isCommandId(id: string): id is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(id);
}

interface BindingOverrides {
  values: Partial<Bindings>;
  explicit: Set<CommandId>;
}

function bindingOverrides(raw: unknown): BindingOverrides {
  const values: Partial<Bindings> = {};
  const explicit = new Set<CommandId>();
  if (!raw || typeof raw !== "object") return { values, explicit };
  for (const [id, accel] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCommandId(id) || typeof accel !== "string") continue;
    values[id] = accel;
    explicit.add(id);
  }
  return { values, explicit };
}

function claimUniqueBinding(
  bindings: Bindings,
  explicit: ReadonlySet<CommandId>,
  owners: Map<Accel, CommandId>,
  id: CommandId,
) {
  const accel = bindings[id];
  if (!accel) return;
  const owner = owners.get(accel);
  if (!owner) {
    owners.set(accel, id);
    return;
  }
  if (explicit.has(id) && !explicit.has(owner)) {
    bindings[owner] = "";
    owners.set(accel, id);
    return;
  }
  bindings[id] = "";
}

function removeDuplicateBindings(bindings: Bindings, explicit: ReadonlySet<CommandId>) {
  const owners = new Map<Accel, CommandId>();
  for (const id of COMMAND_IDS) claimUniqueBinding(bindings, explicit, owners, id);
}

/**
 * Merge user overrides over the defaults, ignoring unknown ids and non-string
 * values — tolerant of hand-edited / version-skewed localStorage (like
 * `loadColumnOrder`). A command missing from the overrides keeps its default.
 */
export function resolveBindings(overrides: unknown): Bindings {
  const overridesById = bindingOverrides(overrides);
  const out: Bindings = { ...DEFAULT_SHORTCUTS, ...overridesById.values };

  // Older persisted objects do not contain newly-added commands. If a new
  // default collides with an explicit user override, preserve the user's chord
  // and leave the new command unbound. Duplicate hand-edits are resolved with
  // the same explicit-over-default priority so one chord always has one owner.
  removeDuplicateBindings(out, overridesById.explicit);
  return out;
}

/** accel → commandId index for O(1) dispatch. */
export function reverseLookup(bindings: Bindings): Map<Accel, CommandId> {
  const map = new Map<Accel, CommandId>();
  for (const id of COMMAND_IDS) {
    const accel = bindings[id];
    if (accel && !map.has(accel)) map.set(accel, id);
  }
  return map;
}

/** Resolve one keyboard event through the reverse index. Kept pure so dispatch
 *  and unbound-command behavior stay node-testable outside App's DOM handler. */
export function commandFromEvent(
  reverse: ReadonlyMap<Accel, CommandId>,
  event: ModifierKeys,
): CommandId | null {
  const accel = accelFromEvent(event);
  return accel ? (reverse.get(accel) ?? null) : null;
}

export interface ShortcutDispatchContext {
  editing: boolean;
  fromFilterInput: boolean;
  modalOpen: boolean;
}

export type ShortcutDispatchResult = "none" | "ignored" | "handled";

type DispatchEvent = ModifierKeys & Pick<KeyboardEvent, "preventDefault">;

/** Dispatch one configurable chord. Direct filter creation remains available
 *  from the app's startup-focused filter bar, stays out of unrelated editors,
 *  and consumes its chord while another modal owns the window so browser-find
 *  cannot appear over that modal. */
export function dispatchShortcutCommand(
  reverse: ReadonlyMap<Accel, CommandId>,
  event: DispatchEvent,
  actions: Readonly<Record<CommandId, () => void>>,
  context: ShortcutDispatchContext,
): ShortcutDispatchResult {
  const command = commandFromEvent(reverse, event);
  if (!command) return "none";
  if (command === "create-filter") {
    if (context.modalOpen) {
      event.preventDefault();
      return "handled";
    }
    if (context.editing && !context.fromFilterInput) return "ignored";
  }
  event.preventDefault();
  actions[command]();
  return "handled";
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

export type AssignBindingResult =
  | { ok: true; bindings: Bindings; swappedWith: CommandId | null }
  | { ok: false; conflict: { kind: "reserved" } };

/** Assign or clear one command. Taking another command's chord swaps that
 *  command onto the assignee's previous chord (or unbinds it when the assignee
 *  was clear), so Ctrl/Cmd+F can genuinely move between filter actions. */
export function assignBinding(
  bindings: Bindings,
  id: CommandId,
  accel: Accel,
): AssignBindingResult {
  if (!accel) return { ok: true, bindings: { ...bindings, [id]: "" }, swappedWith: null };
  const clash = findConflict(bindings, accel, id);
  if (clash?.kind === "reserved") return { ok: false, conflict: clash };
  if (!clash) {
    return { ok: true, bindings: { ...bindings, [id]: accel }, swappedWith: null };
  }
  return {
    ok: true,
    bindings: {
      ...bindings,
      [id]: accel,
      [clash.id]: bindings[id],
    },
    swappedWith: clash.id,
  };
}
