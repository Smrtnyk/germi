import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SaveSessionDialog } from "./SaveSessionDialog";

describe("SaveSessionDialog", () => {
  beforeEach(() => {
    localStorage.removeItem("germi.har.includeRules");
  });

  it("shows the rule count and defaults the embed checkbox to off", async () => {
    const screen = await render(
      <SaveSessionDialog ruleCount={3} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /Include mock rules \(3 rules/ });
    await expect.element(checkbox).toBeVisible();
    await expect.element(checkbox).not.toBeChecked();
  });

  it("saves with the checkbox choice and remembers it for the next dialog", async () => {
    const onSave = vi.fn();
    const screen = await render(
      <SaveSessionDialog ruleCount={1} onSave={onSave} onCancel={vi.fn()} />,
    );
    await screen.getByRole("checkbox", { name: /Include mock rules \(1 rule / }).click();
    await screen.getByRole("button", { name: "Save…" }).click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(true);
    await screen.unmount();

    const next = await render(
      <SaveSessionDialog ruleCount={1} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    await expect.element(next.getByRole("checkbox")).toBeChecked();
  });

  it("treats cancel and Escape as a cancel, never a save", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(
      <SaveSessionDialog ruleCount={2} onSave={onSave} onCancel={onCancel} />,
    );
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
    await screen.unmount();

    const second = await render(
      <SaveSessionDialog ruleCount={2} onSave={onSave} onCancel={onCancel} />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
    await second.unmount();
  });
});
