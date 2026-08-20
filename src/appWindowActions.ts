import type { PaletteAction } from "./components/CommandPalette";

interface AppWindowActionOptions {
  settingsReady: boolean;
  createFilterShortcut?: string;
  openSettings: () => void;
  openFilterWindow: () => void;
}

/** Keep the two detached-window commands distinct at their shared App seam. */
export function buildAppWindowActions(options: AppWindowActionOptions): {
  createFilter: PaletteAction;
  settings: PaletteAction;
} {
  return {
    createFilter: {
      id: "create-filter",
      group: "Traffic",
      label: "Create saved filter…",
      shortcut: options.createFilterShortcut,
      run: options.openFilterWindow,
    },
    settings: {
      id: "settings",
      group: "App",
      label: "Open Settings…",
      disabled: !options.settingsReady,
      run: options.openSettings,
    },
  };
}
