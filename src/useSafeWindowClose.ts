import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useAsyncSubscription } from "./useTauriListen";

type CloseOperation = () => Promise<void>;
type CloseFailureHandler = (error: unknown) => void;
type CloseRequestedHandler = Parameters<ReturnType<typeof getCurrentWindow>["onCloseRequested"]>[0];

interface SafeWindowCloseOptions {
  operation: CloseOperation;
  onFailure: CloseFailureHandler;
  onSetupError?: CloseFailureHandler;
  closeOnEscape?: boolean;
}

function onCurrentWindowCloseRequested(handler: CloseRequestedHandler) {
  return getCurrentWindow().onCloseRequested(handler);
}

/** Coordinate a detached window's Escape and OS-close paths. Only one close
 * operation runs at a time, and a failed flush/destroy leaves the window open. */
export function useSafeWindowClose({
  operation,
  onFailure,
  onSetupError = onFailure,
  closeOnEscape = true,
}: SafeWindowCloseOptions) {
  const operationRef = useRef(operation);
  const failureRef = useRef(onFailure);
  operationRef.current = operation;
  failureRef.current = onFailure;

  const closeTaskRef = useRef<Promise<boolean> | null>(null);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  const beginClose = useCallback(
    (
      overrideOperation?: CloseOperation,
      overrideFailure?: CloseFailureHandler,
    ): Promise<boolean> => {
      const active = closeTaskRef.current;
      if (active) return active;

      closingRef.current = true;
      setClosing(true);
      const closeOperation = overrideOperation ?? operationRef.current;
      const handleFailure = overrideFailure ?? failureRef.current;
      const task = Promise.resolve()
        .then(closeOperation)
        .then(
          () => true,
          (error: unknown) => {
            handleFailure(error);
            return false;
          },
        );
      closeTaskRef.current = task;
      void task.then((closed) => {
        if (closeTaskRef.current !== task || closed) return;
        closeTaskRef.current = null;
        closingRef.current = false;
        setClosing(false);
      });
      return task;
    },
    [],
  );
  const close = useCallback(() => beginClose(), [beginClose]);

  useEffect(() => {
    if (!closeOnEscape) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, closeOnEscape]);

  const ready = useAsyncSubscription(
    onCurrentWindowCloseRequested,
    (event) => {
      event.preventDefault();
      void close();
    },
    onSetupError,
  );

  return { beginClose, close, closing, closingRef, ready };
}
