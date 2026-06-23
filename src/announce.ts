import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import type { Notify } from "./toast";

let granted: boolean | null = null;

async function osNotify(body: string): Promise<boolean> {
  try {
    if (granted === null) {
      granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    }
    if (!granted) return false;
    sendNotification({ title: "Germi", body });
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce a state change: an in-app toast when the window is focused, an OS
 * notification when it isn't — so a toggle fired by the global hotkey is still
 * visible from another app. Falls back to the toast when OS notifications are
 * unavailable (permission denied / no daemon).
 */
export async function announce(notify: Notify, message: string): Promise<void> {
  let focused = true;
  try {
    focused = await getCurrentWindow().isFocused();
  } catch {
    focused = true;
  }
  if (!focused && (await osNotify(message))) return;
  notify("info", message);
}
