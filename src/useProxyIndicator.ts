import { useEffect } from "react";

import { systemIpc } from "./systemIpc";

/**
 * Reflect the system-proxy state on the app's own taskbar/dock icon — the
 * backend composites a status dot into the window icon (teal when routed through
 * Germi, red when off), so the running app's icon shows the state at a glance.
 */
export function useProxyIndicator(systemProxy: boolean): void {
  useEffect(() => {
    void systemIpc.setProxyIndicator(systemProxy).catch(() => {});
  }, [systemProxy]);
}
