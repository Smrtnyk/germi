import { useEffect, useRef } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

import { prettyAccel } from "./hotkey";

/**
 * Register a global OS-level hotkey that fires `action` (latest closure) when
 * pressed. Re-registers only when `accelerator` changes; an empty string means
 * "unbound". `onError` is called if the OS rejects the accelerator (e.g. it is
 * already held by another app).
 */
export function useGlobalHotkey(
  accelerator: string,
  action: () => void,
  onError: (message: string) => void,
): void {
  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => {
    const accel = accelerator.trim();
    if (!accel) return;
    let active = true;

    void (async () => {
      try {
        await unregister(accel).catch(() => {});
        if (!active) return;
        await register(accel, (event) => {
          if (event.state === "Pressed") actionRef.current();
        });
      } catch (e) {
        if (active) onError(`Couldn't register hotkey ${prettyAccel(accel)}: ${String(e)}`);
      }
    })();

    return () => {
      active = false;
      void unregister(accel).catch(() => {});
    };
  }, [accelerator, onError]);
}
