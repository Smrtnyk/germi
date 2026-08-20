import { isEqual } from "es-toolkit";

import type { SettingsDialogDraft } from "./settingsDraft";
import type { SettingsWindowSnapshot } from "./settingsWindowProtocol";

export interface SettingsSaveBaseline {
  revision: number;
  draft: SettingsDialogDraft;
}

export type SettingsDraftReconciliation =
  | { ok: true; draft: SettingsDialogDraft }
  | { ok: false; conflicts: string[] };

const ABSENT = Symbol("absent setting");
type MergeValue = unknown | typeof ABSENT;

function equal(left: MergeValue, right: MergeValue): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  return isEqual(left, right);
}

function isRecord(value: MergeValue): value is Record<string, unknown> {
  return value !== ABSENT && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mergeRecord(
  baseline: Record<string, unknown>,
  edited: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
  conflicts: string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(baseline), ...Object.keys(edited), ...Object.keys(current)]);
  for (const key of keys) {
    const next = mergeValue(
      hasOwn(baseline, key) ? baseline[key] : ABSENT,
      hasOwn(edited, key) ? edited[key] : ABSENT,
      hasOwn(current, key) ? current[key] : ABSENT,
      `${path}.${key}`,
      conflicts,
    );
    if (next !== ABSENT) merged[key] = next;
  }
  return merged;
}

/** Three-way merge a Settings field. Arrays are intentional atomic fields;
 * record values (settings and shortcut/color maps) merge recursively so
 * independent keys survive concurrent main-window and Settings-window edits. */
function mergeValue(
  baseline: MergeValue,
  edited: MergeValue,
  current: MergeValue,
  path: string,
  conflicts: string[],
): MergeValue {
  if (equal(edited, baseline)) return current;
  if (equal(current, baseline) || equal(edited, current)) return edited;

  if (isRecord(baseline) && isRecord(edited) && isRecord(current)) {
    return mergeRecord(baseline, edited, current, path, conflicts);
  }

  conflicts.push(path);
  return current;
}

export function draftFromSnapshot(snapshot: SettingsWindowSnapshot): SettingsDialogDraft {
  return {
    settings: snapshot.settings,
    columnOrder: snapshot.columnOrder,
    shortcuts: snapshot.shortcuts,
    autoLayout: snapshot.autoLayout,
    activeSection: snapshot.activeSection,
  };
}

export function baselineFromSnapshot(snapshot: SettingsWindowSnapshot): SettingsSaveBaseline {
  return { revision: snapshot.revision, draft: draftFromSnapshot(snapshot) };
}

/** Reconcile a modeless Settings draft against the latest main-owned state.
 * Child-only edits win, main-only changes are retained, and a field changed to
 * different values on both sides is reported instead of being overwritten. */
export function reconcileSettingsDraft(
  baseline: SettingsDialogDraft,
  edited: SettingsDialogDraft,
  current: SettingsDialogDraft,
): SettingsDraftReconciliation {
  const conflicts: string[] = [];
  const settings = mergeValue(
    baseline.settings,
    edited.settings,
    current.settings,
    "settings",
    conflicts,
  );
  const columnOrder = mergeValue(
    baseline.columnOrder,
    edited.columnOrder,
    current.columnOrder,
    "columnOrder",
    conflicts,
  );
  const shortcuts = mergeValue(
    baseline.shortcuts,
    edited.shortcuts,
    current.shortcuts,
    "shortcuts",
    conflicts,
  );
  const autoLayout = mergeValue(
    baseline.autoLayout,
    edited.autoLayout,
    current.autoLayout,
    "autoLayout",
    conflicts,
  );
  if (conflicts.length > 0) return { ok: false, conflicts };
  return {
    ok: true,
    draft: {
      settings: settings as SettingsDialogDraft["settings"],
      columnOrder: columnOrder as string[],
      shortcuts: shortcuts as SettingsDialogDraft["shortcuts"],
      autoLayout: autoLayout as SettingsDialogDraft["autoLayout"],
      // The active section is child-owned navigation, not shared app state.
      activeSection: edited.activeSection,
    },
  };
}
