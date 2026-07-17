import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { ScenarioTabs } from "./AutoresponderPanel";
import { GENERAL_SCENARIO_ID, type AutoResponderSummary } from "../types";

function autoresponder(): AutoResponderSummary {
  return {
    scenarios: [
      { id: GENERAL_SCENARIO_ID, name: "General rules", rules: [] },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `scenario-${index}`,
        name: `A very long scenario name ${index}`,
        rules: [],
      })),
    ],
    activeScenarioId: "scenario-0",
    generalActive: true,
  };
}

describe("ScenarioTabs overflow", () => {
  it("shrinks long tabs, preserves their full names, and scrolls only horizontally", async () => {
    const onActivate = vi.fn();
    const screen = await render(
      <div style={{ width: 430 }}>
        <ScenarioTabs
          ar={autoresponder()}
          zone={null}
          zoneProps={() => ({
            onDragOver: vi.fn(),
            onDragLeave: vi.fn(),
            onDrop: vi.fn(),
          })}
          viewedId="scenario-0"
          onSelectView={vi.fn()}
          onActivate={onActivate}
          onOffToggle={vi.fn()}
          onAdd={vi.fn()}
          onImport={vi.fn()}
          onReplace={vi.fn()}
          onExportAll={vi.fn()}
        />
      </div>,
    );

    const strip = document.querySelector(".scenario-tabs") as HTMLElement;
    const tab = screen.getByTitle("A very long scenario name 2");
    const label = tab.element().querySelector(".stab-label") as HTMLElement;

    expect(getComputedStyle(strip).overflowX).toBe("auto");
    expect(getComputedStyle(strip).overflowY).toBe("hidden");
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await tab.click();
    expect(onActivate).toHaveBeenCalledWith("scenario-2");
  });
});
