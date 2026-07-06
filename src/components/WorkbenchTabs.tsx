import { hasFlowDrag } from "../dnd";
import type { RightTab } from "../appState";

/** The Inspector/Autoresponder side of the tab strip: two separate tabs shown
 *  one at a time (issue #108 — there is no combined "Inspector + Autoresponder"
 *  view). A flow-drag onto the Autoresponder tab pulls the panel back over from
 *  the Filters tab so the mock drop target is visible. */
export function WorkbenchTabs({
  rightTab,
  setRightTab,
  activeScenario,
}: {
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  activeScenario: string | null;
}) {
  return (
    <>
      <button
        className={rightTab === "inspector" ? "tab active" : "tab"}
        onClick={() => setRightTab("inspector")}
      >
        Inspector
      </button>
      <button
        className={rightTab === "autoresponder" ? "tab active" : "tab"}
        onClick={() => setRightTab("autoresponder")}
        onDragEnter={(e) => {
          if (hasFlowDrag(e.dataTransfer.types)) setRightTab("autoresponder");
        }}
      >
        Autoresponder
        {activeScenario && <span className="live-dot" />}
      </button>
    </>
  );
}
