import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

import { IconCheck, IconClose, IconInfo, IconWarn } from "./components/icons";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const DURATION: Record<ToastKind, number> = {
  success: 3200,
  info: 4500,
  error: 8000,
};

const MAX_VISIBLE = 4;

export function friendlyError(raw: string): string {
  const s = raw.replace(/^(?:Error:\s*)+/i, "").trim();
  const low = s.toLowerCase();
  if (low.includes("in use") || low.includes("os error 98") || low.includes("os error 10048")) {
    return "That port is already in use — pick another in Settings → Connections.";
  }
  // Windows WSAEACCES on a bind: the port is OS-reserved (a high port too, not
  // just <1024 — e.g. an excluded port range) or held by a privileged service.
  if (low.includes("os error 10013") || (low.includes("access") && low.includes("permitted"))) {
    return "That port isn't available — it may be reserved by the OS or another app (ports under 1024 also need elevated rights). Pick a different port.";
  }
  // EACCES: a bind (proxy-core tags these "failed to bind") is a privileged/
  // restricted port; a bare permission-denied (e.g. a file write) stays neutral.
  if (low.includes("permission denied") || low.includes("os error 13")) {
    if (low.includes("failed to bind")) {
      return "That port needs elevated rights (ports under 1024 are privileged) or is otherwise restricted. Pick a higher port.";
    }
    return `Permission denied — ${s}`;
  }
  if (low.includes("no such file") || low.includes("not found")) {
    return s;
  }
  return s || "Something went wrong.";
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (kind: ToastKind, message: string) => {
      const text = kind === "error" ? friendlyError(message) : message;
      if (!text) return -1;
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, kind, message: text }].slice(-MAX_VISIBLE));
      const handle = window.setTimeout(() => dismiss(id), DURATION[kind]);
      timers.current.set(id, handle);
      return id;
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}

export type Notify = (kind: ToastKind, message: string) => void;

const ToastContext = createContext<Notify>(() => -1);
export const ToastProvider = ToastContext.Provider;
export function useToast(): Notify {
  return useContext(ToastContext);
}

const ICON: Record<ToastKind, ReactNode> = {
  success: <IconCheck />,
  error: <IconWarn />,
  info: <IconInfo />,
};

const ICON_LABEL: Record<ToastKind, string> = {
  success: "Success",
  error: "Warning",
  info: "Info",
};

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="toast-icon" title={ICON_LABEL[t.kind]}>
            {ICON[t.kind]}
          </span>
          <span className="toast-msg">{t.message}</span>
          <button
            className="toast-x"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}
