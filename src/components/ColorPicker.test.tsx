import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { ColorPicker } from "./ColorPicker";
import { Modal } from "./ui/Modal";

function renderPicker(overrides: Partial<Parameters<typeof ColorPicker>[0]> = {}) {
  return render(
    <ColorPicker
      label="Accent"
      value={{ hex: "#336699", alphaPct: 16 }}
      swatchBackground="color-mix(in srgb, #336699 16%, transparent)"
      onCommit={vi.fn()}
      {...overrides}
    />,
  );
}

function clickBackdrop(dialog: HTMLDialogElement) {
  const rect = dialog.getBoundingClientRect();
  dialog.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: rect.left - 1,
      clientY: rect.top - 1,
    }),
  );
}

describe("ColorPicker", () => {
  it("opens from the keyboard and focuses the native hue control", async () => {
    const screen = await renderPicker();
    const trigger = screen.getByRole("button", { name: "Accent color" });
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");

    await expect.element(screen.getByRole("dialog", { name: "Accent color" })).toBeVisible();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(screen.getByLabelText("Accent hue").element());
  });

  it("previews keyboard opacity changes but Cancel does not commit them", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderPicker({ onPreview, onCommit, onCancel });
    const trigger = screen.getByRole("button", { name: "Accent color" });
    await trigger.click();
    const slider = screen.getByRole("slider", { name: "Accent opacity" });
    slider.element().focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onPreview).toHaveBeenLastCalledWith({ hex: "#336699", alphaPct: 17 });
    expect(onCommit).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger.element());
  });

  it("treats Escape as cancel without committing the draft", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onOuterClose = vi.fn();
    const screen = await render(
      <Modal ariaLabel="Settings" onClose={onOuterClose}>
        <ColorPicker
          label="Accent"
          value={{ hex: "#336699", alphaPct: 16 }}
          swatchBackground="color-mix(in srgb, #336699 16%, transparent)"
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </Modal>,
    );
    await screen.getByRole("button", { name: "Accent color" }).click();
    await screen.getByLabelText("Hex").fill("#11223380");
    await userEvent.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onOuterClose).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  it("commits a normalized 8-digit value exactly once on Apply", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderPicker({ onCommit, onCancel });
    await screen.getByRole("button", { name: "Accent color" }).click();
    await screen.getByLabelText("Hex").fill("11223380");

    expect(onCommit).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ hex: "#112233", alphaPct: 50 });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps an outside click inert without losing or committing the draft", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderPicker({ onPreview, onCommit, onCancel });
    const trigger = screen.getByRole("button", { name: "Accent color" });
    await trigger.click();
    const dialog = screen.getByRole("dialog", { name: "Accent color" });
    await screen.getByLabelText("Hex").fill("#11223380");

    expect(onPreview).toHaveBeenLastCalledWith({ hex: "#112233", alphaPct: 50 });
    clickBackdrop(dialog.element() as HTMLDialogElement);

    await expect.element(dialog).toBeVisible();
    await expect.element(dialog).toHaveAttribute("closedby", "closerequest");
    await expect.element(screen.getByLabelText("Hex")).toHaveValue("#11223380");
    await expect.element(screen.getByText("50%")).toBeVisible();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ hex: "#112233", alphaPct: 50 });
  });

  it("blocks Apply while the hex draft is invalid", async () => {
    const onCommit = vi.fn();
    const screen = await renderPicker({ onCommit });
    await screen.getByRole("button", { name: "Accent color" }).click();
    await screen.getByLabelText("Hex").fill("nope");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("Use 6- or 8-digit hex.");
    await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
