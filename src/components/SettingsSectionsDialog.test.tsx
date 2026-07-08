import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsSectionsDialog } from "./SettingsSectionsDialog";
import type { SettingsSectionSummary } from "../types";

const SECTIONS: SettingsSectionSummary[] = [
  { id: "connections", label: "Connections", detail: "port 8080" },
  { id: "interception", label: "Host exclusions", detail: "3 excluded hosts" },
  { id: "throttling", label: "Throttling", detail: "off" },
];

function renderDialog(over: Partial<Parameters<typeof SettingsSectionsDialog>[0]> = {}) {
  return render(
    <SettingsSectionsDialog
      title="Export settings"
      message="Pick what to export."
      sections={SECTIONS}
      confirmLabel="Export…"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...over}
    />,
  );
}

describe("SettingsSectionsDialog", () => {
  it("lists every section with its detail, all checked by default", async () => {
    const screen = await renderDialog();
    await expect.element(screen.getByRole("heading", { name: "Export settings" })).toBeVisible();
    for (const s of SECTIONS) {
      const box = screen.getByRole("checkbox", { name: new RegExp(s.label) });
      await expect.element(box).toBeChecked();
    }
    await expect.element(screen.getByText("3 excluded hosts")).toBeVisible();
  });

  it("confirms with only the sections left checked, in registry order", async () => {
    const onConfirm = vi.fn();
    const screen = await renderDialog({ onConfirm });
    await screen.getByRole("checkbox", { name: /Connections/ }).click();
    await screen.getByRole("button", { name: "Export…" }).click();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(["interception", "throttling"]);
  });

  it("disables confirm when nothing is checked, and None/All flip the whole list", async () => {
    const screen = await renderDialog();
    await screen.getByRole("button", { name: "None" }).click();
    await expect.element(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
    await expect.element(screen.getByRole("checkbox", { name: /Throttling/ })).not.toBeChecked();
    await screen.getByRole("button", { name: "All" }).click();
    await expect.element(screen.getByRole("button", { name: "Export…" })).toBeEnabled();
    await expect.element(screen.getByRole("checkbox", { name: /Throttling/ })).toBeChecked();
  });

  it("cancel and Escape call onCancel, never onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const first = await renderDialog({ onConfirm, onCancel });
    await first.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
    await first.unmount();

    const escCancel = vi.fn();
    await renderDialog({ onConfirm, onCancel: escCancel });
    await userEvent.keyboard("{Escape}");
    expect(escCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
