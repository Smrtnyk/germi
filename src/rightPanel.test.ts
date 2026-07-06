import { describe, expect, it } from "vitest";

import { paneVisibility } from "./rightPanel";
import type { RightTab } from "./appState";

const TABS: RightTab[] = ["inspector", "autoresponder", "filters", "scripts"];

describe("paneVisibility", () => {
  it("shows exactly one pane for every tab", () => {
    for (const tab of TABS) {
      const shown = Object.values(paneVisibility(tab)).filter(Boolean);
      expect(shown, `tab ${tab} should light exactly one pane`).toHaveLength(1);
    }
  });

  it("maps each tab to its own pane", () => {
    expect(paneVisibility("inspector")).toEqual({
      filters: false,
      scripts: false,
      inspector: true,
      auto: false,
    });
    expect(paneVisibility("autoresponder")).toEqual({
      filters: false,
      scripts: false,
      inspector: false,
      auto: true,
    });
    expect(paneVisibility("filters")).toEqual({
      filters: true,
      scripts: false,
      inspector: false,
      auto: false,
    });
    expect(paneVisibility("scripts")).toEqual({
      filters: false,
      scripts: true,
      inspector: false,
      auto: false,
    });
  });

  // Issue #108: the old top-level "Split" mode showed the Inspector and the
  // Autoresponder together in one tab. That combined view is gone — the two are
  // now mutually exclusive tabs, so no tab may light both panes at once.
  it("never shows Inspector and Autoresponder at the same time", () => {
    for (const tab of TABS) {
      const v = paneVisibility(tab);
      expect(v.inspector && v.auto, `tab ${tab} must not show both panes`).toBe(false);
    }
  });
});
