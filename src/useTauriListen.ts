import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Subscribe through an async Tauri-style registration function, always invoking
 * the latest handler and disposing a subscription that resolves after unmount. */
export function useAsyncSubscription<Args extends unknown[], Result>(
  subscribe: (handler: (...args: Args) => Result) => Promise<UnlistenFn>,
  handler: (...args: Args) => Result,
  onError?: (error: unknown) => void,
): boolean {
  const handlerRef = useRef(handler);
  const errorRef = useRef(onError);
  handlerRef.current = handler;
  errorRef.current = onError;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    setReady(false);
    void subscribe((...args) => handlerRef.current(...args))
      .then((fn) => {
        if (active) {
          unlisten = fn;
          setReady(true);
        } else fn();
      })
      .catch((error: unknown) => {
        if (active) errorRef.current?.(error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [subscribe]);

  return ready;
}

/** Subscribe to a Tauri backend event, always invoking the latest handler. */
export function useTauriListen<T = unknown>(event: string, handler: (payload: T) => void): void {
  const subscribe = useCallback(
    (onPayload: (payload: T) => void) =>
      listen<T>(event, (tauriEvent) => onPayload(tauriEvent.payload)),
    [event],
  );
  useAsyncSubscription(subscribe, handler);
}
