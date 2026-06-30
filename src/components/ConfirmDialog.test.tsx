import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("shows the title, message and a custom confirm label", async () => {
    const screen = await render(
      <ConfirmDialog
        title="Delete scenario?"
        message="This cannot be undone."
        confirmLabel="Delete it"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("heading", { name: "Delete scenario?" })).toBeVisible();
    await expect.element(screen.getByText("This cannot be undone.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Delete it" })).toBeVisible();
  });

  it("calls onConfirm (and not onCancel) when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(
      <ConfirmDialog
        title="Proceed?"
        message="Go ahead."
        confirmLabel="Yes"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await screen.getByRole("button", { name: "Yes" }).click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button closes the dialog", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(
      <ConfirmDialog
        title="Proceed?"
        message="Go ahead."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("treats an Escape dismissal as a cancel", async () => {
    const onCancel = vi.fn();
    await render(
      <ConfirmDialog
        title="Proceed?"
        message="Go ahead."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("styles the confirm button as dangerous only when asked", async () => {
    const danger = await render(
      <ConfirmDialog
        title="Drop?"
        message="x"
        confirmLabel="Drop"
        danger
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await expect.element(danger.getByRole("button", { name: "Drop" })).toHaveClass("danger");
    await danger.unmount();

    const safe = await render(
      <ConfirmDialog
        title="Save?"
        message="x"
        confirmLabel="Save"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await expect.element(safe.getByRole("button", { name: "Save" })).toHaveClass("primary");
  });
});
