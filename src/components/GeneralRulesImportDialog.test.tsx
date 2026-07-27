import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { GeneralRulesImportMode, ScenarioPreview } from "../types";
import { GeneralRulesImportDialog } from "./GeneralRulesImportDialog";

const PREVIEWS: ScenarioPreview[] = [
  { name: "General rules", ruleCount: 2, isGeneral: true },
  { name: "Checkout", ruleCount: 5, isGeneral: false },
];

function renderDialog(over: Partial<Parameters<typeof GeneralRulesImportDialog>[0]> = {}) {
  return render(
    <GeneralRulesImportDialog
      previews={PREVIEWS}
      existingGeneralRuleCount={3}
      replaceScenarios={false}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...over}
    />,
  );
}

describe("GeneralRulesImportDialog", () => {
  it("explains both rule sets and defaults to a non-destructive General merge", async () => {
    const screen = await renderDialog();

    await expect
      .element(screen.getByRole("heading", { name: "Import General rules?" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("This file contains 2 General rules.", { exact: false }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Add 2 imported rules after your 3 existing General rules.", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("radio", { name: /Merge into General/ })).toBeChecked();
    await expect.element(screen.getByText(/other scenario.*added/, { exact: false })).toBeVisible();
  });

  it.each([
    ["merge", /Merge into General/],
    ["replace", /Replace General/],
    ["asScenario", /Import as a scenario/],
  ] satisfies Array<[GeneralRulesImportMode, RegExp]>)(
    "confirms the %s destination",
    async (mode, label) => {
      const onConfirm = vi.fn();
      const screen = await renderDialog({ onConfirm });

      await screen.getByRole("radio", { name: label }).click();
      await screen.getByRole("button", { name: "Import rules" }).click();

      expect(onConfirm).toHaveBeenCalledExactlyOnceWith(mode);
    },
  );

  it("calls onCancel for both the Cancel button and Escape", async () => {
    const buttonCancel = vi.fn();
    const first = await renderDialog({ onCancel: buttonCancel });
    await first.getByRole("button", { name: "Cancel" }).click();
    expect(buttonCancel).toHaveBeenCalledOnce();
    await first.unmount();

    const escapeCancel = vi.fn();
    await renderDialog({ onCancel: escapeCancel });
    await userEvent.keyboard("{Escape}");
    expect(escapeCancel).toHaveBeenCalledOnce();
  });

  it("warns that ordinary scenarios will be replaced in replace mode", async () => {
    const screen = await renderDialog({ replaceScenarios: true });
    await expect
      .element(screen.getByText(/other scenario.*replace/, { exact: false }))
      .toBeVisible();
  });
});
