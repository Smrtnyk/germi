import { useEffect } from "react";

import { systemIpc } from "./systemIpc";

/**
 * Reflect the system-proxy state on the app's own taskbar/dock icon — the
 * backend composites a teal status dot into the window icon while routed through
 * Germi and restores the ordinary icon when routing is off.
 */
export function useProxyIndicator(systemProxy: boolean): void {
  useEffect(() => {
    void systemIpc.setProxyIndicator(systemProxy).catch(() => {});
  }, [systemProxy]);
}
