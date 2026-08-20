import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { DEFAULT_FILTER_COLOR_PRESETS, filterColorPresetParts } from "../filterColorPresets";
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
  it("selects a complete preset by native radio keyboard interaction before one Apply", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const presets = filterColorPresetParts(DEFAULT_FILTER_COLOR_PRESETS.slice(0, 3));
    const screen = await renderPicker({ value: presets[0], presets, onPreview, onCommit });
    await screen.getByRole("button", { name: "Accent color" }).click();
    const first = screen.getByRole("radio", { name: /^Preset 1,/ });
    const second = screen.getByRole("radio", { name: /^Preset 2,/ });
    const presetsGroup = screen.getByRole("group", { name: "Filter color presets" });

    await expect.element(first).toBeChecked();
    await expect.element(first).toHaveFocus();
    const focusRule = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((rule) => rule.cssText.includes("label:has(input:focus-visible)"));
    expect(focusRule?.cssText).toContain("outline: 2px solid var(--accent)");
    await userEvent.keyboard("{ArrowRight}");

    await expect.element(second).toBeChecked();
    await expect.element(presetsGroup.getByText("Preset 2 selected")).toBeVisible();
    expect(onPreview).toHaveBeenLastCalledWith(presets[1]);
    expect(onCommit).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(presets[1]);
  });

  it("keeps ten swatch-only radio targets compact and contained at default and narrow widths", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(561, 800);

    try {
      const presets = filterColorPresetParts(DEFAULT_FILTER_COLOR_PRESETS);
      const screen = await renderPicker({ value: presets[0], presets });
      await screen.getByRole("button", { name: "Accent color" }).click();

      const dialog = screen.getByRole("dialog", { name: "Accent color" }).element();
      const grid = dialog.querySelector<HTMLElement>(".color-picker-preset-grid")!;
      const labels = [...grid.querySelectorAll<HTMLLabelElement>("label")];
      expect(labels).toHaveLength(10);
      expect(grid.querySelector(".color-picker-preset-name")).toBeNull();

      for (const [index, preset] of presets.entries()) {
        const radio = screen.getByRole("radio", {
          name: `Preset ${index + 1}, ${preset.hex}, ${preset.alphaPct}% opacity`,
        });
        await expect.element(radio).toBeVisible();
        expect(radio.element().getBoundingClientRect().width).toBeGreaterThan(0);
      }

      const coarsePointerRule = [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .find(
          (rule) =>
            rule.cssText.includes("@media (pointer: coarse)") &&
            rule.cssText.includes(".color-picker-preset-grid label"),
        );
      expect(coarsePointerRule?.cssText).toContain("min-block-size: 44px");

      for (const width of [561, 320]) {
        await page.viewport(width, 800);
        const gridRect = grid.getBoundingClientRect();
        expect(grid.scrollWidth, `${width}px grid overflow`).toBeLessThanOrEqual(grid.clientWidth);

        for (const label of labels) {
          const labelRect = label.getBoundingClientRect();
          const swatchRect = label
            .querySelector<HTMLElement>(".color-picker-preset-swatch")!
            .getBoundingClientRect();
          expect(labelRect.width, `${width}px target width`).toBeGreaterThanOrEqual(24);
          expect(labelRect.height, `${width}px target height`).toBeGreaterThanOrEqual(36);
          expect(labelRect.height, `${width}px compact target height`).toBeLessThanOrEqual(44);
          expect(labelRect.left).toBeGreaterThanOrEqual(gridRect.left);
          expect(labelRect.right).toBeLessThanOrEqual(gridRect.right);
          expect(swatchRect.width, `${width}px compact swatch width`).toBeLessThanOrEqual(38);
          expect(swatchRect.height, `${width}px compact swatch height`).toBeLessThanOrEqual(18);
          expect(swatchRect.left).toBeGreaterThanOrEqual(labelRect.left);
          expect(swatchRect.right).toBeLessThanOrEqual(labelRect.right);
        }
      }
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("marks a manual value as custom and cancels a preset draft on Escape", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const presets = filterColorPresetParts(DEFAULT_FILTER_COLOR_PRESETS.slice(0, 3));
    const screen = await renderPicker({ presets, onPreview, onCommit, onCancel });
    await screen.getByRole("button", { name: "Accent color" }).click();
    const presetsGroup = screen.getByRole("group", { name: "Filter color presets" });

    await expect.element(presetsGroup.getByText("Custom color selected")).toBeVisible();
    for (const radio of screen.getByRole("radio").all())
      await expect.element(radio).not.toBeChecked();

    await screen.getByRole("radio", { name: /^Preset 3,/ }).click();
    expect(onPreview).toHaveBeenLastCalledWith(presets[2]);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

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
