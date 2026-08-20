import { isEqual } from "es-toolkit";

import type { AutoLayout } from "./appState";
import type { Bindings } from "./shortcuts";
import type { ProxySettings } from "./types";

export interface SettingsDialogDraft {
  settings: ProxySettings;
  columnOrder: string[];
  shortcuts: Bindings;
  autoLayout: AutoLayout;
  activeSection: string;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface SettingsWriteResult {
  settings: ProxySettings;
  rejection: unknown | null;
  readBack: boolean;
}

/** Navigation alone is not an unsaved setting: the last section is persisted
 * only as a convenience when substantive dialog values are saved. */
export function hasUnsavedSettingsChanges(
  current: SettingsDialogDraft,
  saved: SettingsDialogDraft,
): boolean {
  return (
    !isEqual(current.settings, saved.settings) ||
    !isEqual(current.columnOrder, saved.columnOrder) ||
    !isEqual(current.shortcuts, saved.shortcuts) ||
    current.autoLayout !== saved.autoLayout
  );
}

const LOCAL_OPTION_KEYS = [
  "germi.columns",
  "germi.shortcuts",
  "germi.autoLayout",
  "germi.settingsSection",
] as const;

function localValues(draft: SettingsDialogDraft): readonly string[] {
  return [
    JSON.stringify(draft.columnOrder),
    JSON.stringify(draft.shortcuts),
    draft.autoLayout,
    draft.activeSection,
  ];
}

function restoreLocalOptions(storage: StorageLike, previous: readonly (string | null)[]): void {
  for (let i = 0; i < LOCAL_OPTION_KEYS.length; i += 1) {
    const value = previous[i];
    if (value === null) storage.removeItem(LOCAL_OPTION_KEYS[i]);
    else storage.setItem(LOCAL_OPTION_KEYS[i], value);
  }
}

/** Resolve an ambiguous backend rejection against an authoritative readback. */
export async function settleSettingsWrite(
  attempted: ProxySettings,
  write: () => Promise<void>,
  read: () => Promise<ProxySettings>,
): Promise<SettingsWriteResult> {
  try {
    await write();
    return { settings: attempted, rejection: null, readBack: false };
  } catch (writeError) {
    let authoritative: ProxySettings;
    try {
      authoritative = await read();
    } catch (readError) {
      throw Object.assign(
        new Error(`Settings could not be saved (${writeError}) or reloaded (${readError})`),
        { cause: writeError },
      );
    }
    return {
      settings: authoritative,
      rejection: isEqual(authoritative, attempted) ? null : writeError,
      readBack: true,
    };
  }
}

/**
 * Commit the dialog-owned local options before the backend snapshot. Local
 * storage is synchronous and recoverable, so a backend rejection can restore
 * every old value without exposing the failed draft to the live React state.
 */
export async function persistSettingsDialogDraft(
  storage: StorageLike,
  draft: SettingsDialogDraft,
  persistBackend: (settings: ProxySettings) => Promise<void>,
): Promise<void> {
  const previous = LOCAL_OPTION_KEYS.map((key) => storage.getItem(key));
  try {
    const values = localValues(draft);
    for (let i = 0; i < LOCAL_OPTION_KEYS.length; i += 1) {
      storage.setItem(LOCAL_OPTION_KEYS[i], values[i]);
    }
  } catch (writeError) {
    try {
      restoreLocalOptions(storage, previous);
    } catch (rollbackError) {
      throw Object.assign(
        new Error(
          `Local settings could not be written (${writeError}) or restored (${rollbackError})`,
        ),
        { cause: writeError },
      );
    }
    throw writeError;
  }

  try {
    await persistBackend(draft.settings);
  } catch (backendError) {
    try {
      restoreLocalOptions(storage, previous);
    } catch (rollbackError) {
      throw Object.assign(
        new Error(
          `Settings were not saved (${backendError}), and local options could not be restored ` +
            `(${rollbackError})`,
        ),
        { cause: backendError },
      );
    }
    throw backendError;
  }
}
