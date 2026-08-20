import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const SETTINGS_WINDOW_LABEL = "settings";
export const SETTINGS_WINDOW_OPTIONS = {
  title: "Settings",
  width: 900,
  height: 700,
  minWidth: 680,
  minHeight: 520,
  resizable: true,
  decorations: true,
  // Match main/compare: WebView2's native handler otherwise intercepts HTML5
  // drag events on Windows, breaking Appearance hue copy and Columns reorder.
  dragDropEnabled: false,
} as const;

let opening: Promise<"focused" | "created" | "replaced"> | null = null;

/** Open the singleton Settings window. `beginSession` runs only after the
 * singleton check and before construction, so the main listener accepts the
 * child's first ready event without invalidating an already-open session. */
export function openOrFocusSettingsWindow(
  beginSession: () => string,
  activeSession: () => string | null,
  recoverOrphan: () => Promise<void> = () => Promise.resolve(),
): Promise<"focused" | "created" | "replaced"> {
  if (opening) return opening;
  const task = (async () => {
    const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
    let replaced = false;
    if (existing) {
      if (activeSession()) {
        await existing.setFocus();
        return "focused" as const;
      }
      // A main-webview reload loses the in-memory owner/session while the OS
      // window can survive. It cannot safely transact with the new main, so
      // replace it with a newly sessioned singleton.
      await existing.destroy();
      await recoverOrphan();
      replaced = true;
    }
    const sessionId = beginSession();
    const win = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
      ...SETTINGS_WINDOW_OPTIONS,
      url: `index.html?settings=${encodeURIComponent(sessionId)}`,
    });
    await new Promise<void>((resolve, reject) => {
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (event) => reject(new Error(String(event.payload))));
    });
    return replaced ? ("replaced" as const) : ("created" as const);
  })();
  opening = task;
  void task.then(
    () => {
      if (opening === task) opening = null;
    },
    () => {
      if (opening === task) opening = null;
    },
  );
  return task;
}

export async function isSettingsWindowOpen(): Promise<boolean> {
  return (await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL)) !== null;
}

/** Main-window unmount fallback. Normal app close uses the cooperative
 * shutdown protocol first; this prevents a reload/crash teardown from leaving
 * an orphaned singleton with an unusable old session. */
export async function destroySettingsWindowFromMain(): Promise<void> {
  await (await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL))?.destroy();
}

export async function closeSettingsWindow(): Promise<void> {
  try {
    const main = await WebviewWindow.getByLabel("main");
    await main?.setFocus();
  } catch {
    // Focus restoration is a courtesy; it must never strand Settings.
  }
  await getCurrentWindow().destroy();
}
