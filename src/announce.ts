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
 * Announce a state change fired by the global hotkey via an OS notification, so
 * it's visible from another app and doesn't duplicate the system notification
 * with an in-app toast. Falls back to a toast only when OS notifications are
 * unavailable (permission denied / no daemon). In-app toggles toast directly
 * and don't call this.
 */
export async function announce(notify: Notify, message: string): Promise<void> {
  if (await osNotify(message)) return;
  notify("info", message);
}
