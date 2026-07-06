import type { RightTab } from "./appState";

/** Which pane shows for the active tab — exactly one at a time. Inspector and
 *  Autoresponder are separate tabs (never shown together), so the old combined
 *  "Inspector + Autoresponder" split view no longer exists (issue #108). */
export function paneVisibility(rightTab: RightTab) {
  return {
    filters: rightTab === "filters",
    scripts: rightTab === "scripts",
    inspector: rightTab === "inspector",
    auto: rightTab === "autoresponder",
  };
}
