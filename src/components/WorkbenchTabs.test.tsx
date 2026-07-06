import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkbenchTabs } from "./WorkbenchTabs";

describe("WorkbenchTabs", () => {
  it("renders Inspector and Autoresponder as two separate tabs", async () => {
    const screen = await render(
      <WorkbenchTabs rightTab="inspector" setRightTab={() => {}} activeScenario={null} />,
    );
    await expect.element(screen.getByRole("button", { name: "Inspector" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Autoresponder" })).toBeVisible();
    // Issue #108: the old combined "Inspector + Autoresponder" tab is gone.
    expect(screen.container.textContent).not.toContain("Inspector + Autoresponder");
  });

  it("highlights only the active tab", async () => {
    const screen = await render(
      <WorkbenchTabs rightTab="autoresponder" setRightTab={() => {}} activeScenario={null} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Autoresponder" }))
      .toHaveClass(/active/);
    await expect
      .element(screen.getByRole("button", { name: "Inspector" }))
      .not.toHaveClass(/active/);
  });

  it("switches to the clicked tab", async () => {
    const setRightTab = vi.fn();
    const screen = await render(
      <WorkbenchTabs rightTab="inspector" setRightTab={setRightTab} activeScenario={null} />,
    );
    await screen.getByRole("button", { name: "Autoresponder" }).click();
    expect(setRightTab).toHaveBeenCalledWith("autoresponder");
    await screen.getByRole("button", { name: "Inspector" }).click();
    expect(setRightTab).toHaveBeenCalledWith("inspector");
  });

  it("marks the Autoresponder tab with a live dot when a scenario is active", async () => {
    const screen = await render(
      <WorkbenchTabs rightTab="inspector" setRightTab={() => {}} activeScenario="Scenario 1" />,
    );
    expect(screen.container.querySelector(".live-dot")).not.toBeNull();
  });
});
