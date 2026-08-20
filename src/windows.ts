import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { getTheme } from "./theme";

type WindowOptions = NonNullable<ConstructorParameters<typeof WebviewWindow>[1]>;

/**
 * Bring an existing secondary window to the front, or create it. Creation
 * resolves once the OS window actually exists and rejects on failure (e.g. a
 * label race) — shared by the detached rule editors (issue #72) and the
 * compare window (issue #86).
 */
export async function openOrFocusWindow(
  label: string,
  options: WindowOptions,
): Promise<"focused" | "created"> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return "focused";
  }
  const url = options.url;
  const themedOptions =
    typeof url === "string"
      ? { ...options, url: `${url}${url.includes("?") ? "&" : "?"}theme=${getTheme()}` }
      : options;
  const win = new WebviewWindow(label, themedOptions);
  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  return "created";
}
