import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Subscribe to a Tauri backend event, always invoking the latest handler. */
export function useTauriListen<T = unknown>(event: string, handler: (payload: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<T>(event, (e) => ref.current(e.payload)).then((un) => {
      if (active) unlisten = un;
      else un();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [event]);
}
