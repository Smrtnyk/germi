import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { delay } from "es-toolkit";

import "../styles.css";
import { applyHighlightColors, HIGHLIGHT_COLORS } from "../theme";
import type { ProxySettings } from "../types";
import { AppearanceSettings } from "./AppearanceSettings";

function settings(colors: Record<string, string> = {}): ProxySettings {
  return {
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    highlightColors: colors,
  };
}

function canonical(value: string): string {
  if (value.startsWith("#"))
    return value.length === 7 ? `${value.toLowerCase()}ff` : value.toLowerCase();
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`unsupported color: ${value}`);
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4]) * 255)];
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

async function setColorInput(el: HTMLInputElement, hex: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, hex);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(0);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const rootStyle = () => document.documentElement.style;

const OUTPUT_CLASSES: Record<string, string> = {
  selected: "flow-row selected",
  multiSelected: "flow-row checked",
  filterMatch: "flow-row match",
  mockedRow: "flow-row ruled",
  importedRow: "flow-row imported",
  compareMatchLeft: "compare-row hit-a",
  compareMatchRight: "compare-row hit-b",
  diffAdded: "diff-line add",
  diffRemoved: "diff-line del",
};

function AppliedHighlightSurfaces() {
  return (
    <div>
      <div className="flow-canvas" data-color-surface style={{ background: "var(--bg)" }}>
        {HIGHLIGHT_COLORS.filter((spec) => spec.group === "rows").map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
      <div className="compare-pane" data-color-surface>
        {HIGHLIGHT_COLORS.filter((spec) => spec.key.startsWith("compareMatch")).map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
      <div className="diff-section" data-color-surface>
        {HIGHLIGHT_COLORS.filter((spec) => spec.key.startsWith("diff")).map((spec) => (
          <div key={spec.key} className={OUTPUT_CLASSES[spec.key]} data-output-key={spec.key} />
        ))}
      </div>
    </div>
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("HIGHLIGHT_COLORS vs styles.css", () => {
  it("mirrors every :root default", () => {
    const computed = getComputedStyle(document.documentElement);
    for (const s of HIGHLIGHT_COLORS) {
      expect(canonical(computed.getPropertyValue(s.cssVar).trim()), s.cssVar).toBe(s.defaultValue);
      if (s.derivedVar) expect(computed.getPropertyValue(s.derivedVar).trim()).not.toBe("");
    }
  });
});

describe("AppearanceSettings", () => {
  it("renders the shared picker for every highlight color", async () => {
    const screen = await render(<AppearanceSettings settings={settings()} onChange={vi.fn()} />);
    await expect.element(screen.getByText("Traffic rows")).toBeVisible();
    await expect.element(screen.getByText("Compare & diff")).toBeVisible();
    for (const s of HIGHLIGHT_COLORS) {
      await expect.element(screen.getByRole("button", { name: `${s.label} color` })).toBeVisible();
    }
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0);
    await screen.getByRole("button", { name: "Multi-selected rows color" }).click();
    await expect
      .element(screen.getByRole("slider", { name: "Multi-selected rows opacity" }))
      .toBeVisible();
    await expect.element(screen.getByText("13%")).toBeVisible();
  });

  it("previews each applied output over the same traffic backdrop", async () => {
    const colors = Object.fromEntries(HIGHLIGHT_COLORS.map((spec) => [spec.key, "#33669980"]));
    applyHighlightColors(colors);
    await render(
      <>
        <AppearanceSettings settings={settings(colors)} onChange={vi.fn()} />
        <AppliedHighlightSurfaces />
      </>,
    );

    for (const spec of HIGHLIGHT_COLORS) {
      const picker = document.querySelector<HTMLElement>(`[data-color-key="${spec.key}"]`)!;
      const preview = picker.querySelector<HTMLElement>(".color-picker-swatch")!;
      const previewTint = picker.querySelector<HTMLElement>(".color-picker-swatch-tint")!;
      const output = document.querySelector<HTMLElement>(`[data-output-key="${spec.key}"]`)!;
      const outputSurface = output.closest<HTMLElement>("[data-color-surface]")!;
      expect(getComputedStyle(previewTint).backgroundColor, spec.key).toBe(
        getComputedStyle(output).backgroundColor,
      );
      expect(getComputedStyle(preview).backgroundColor, spec.key).toBe(
        getComputedStyle(outputSurface).backgroundColor,
      );
      expect(getComputedStyle(preview).backgroundColor, spec.key).toBe("rgb(14, 17, 22)");
    }
  });

  it("previews opacity live but commits it only once on Apply", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const slider = screen.getByRole("slider", { name: "Selected row opacity" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}");

    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ selected: "#173a36fc" });
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");
  });

  it("reverts a live preview on Cancel without persisting it", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const slider = screen.getByRole("slider", { name: "Selected row opacity" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("reverts a live preview on Escape and returns focus without persisting it", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Selected row color" });
    await trigger.click();
    await screen.getByRole("slider", { name: "Selected row opacity" }).fill("40");
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a3666");

    await userEvent.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
    expect(document.activeElement).toBe(trigger.element());
  });

  it("commits a hue keeping the row's opacity and derives the diff mark", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Diff — added lines color" }).click();
    const hue = screen.getByLabelText("Diff — added lines hue");
    await setColorInput(hue.element() as HTMLInputElement, "#112233");
    expect(onChange).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ diffAdded: "#11223317" });
    expect(rootStyle().getPropertyValue("--diff-add-bg")).toBe("#11223317");
    expect(rootStyle().getPropertyValue("--diff-add-hl")).toBe("#11223345");
  });

  it("commits a typed 6-digit hex keeping the row's opacity", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Diff — added lines color" }).click();
    await screen.getByLabelText("Hex").fill("#112233");
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ diffAdded: "#11223317" });
  });

  it("commits a typed 8-digit hex including its alpha", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    await screen.getByLabelText("Hex").fill("11223380");
    expect(onChange).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ selected: "#11223380" });
  });

  it("does not allow an unparseable hex entry to save", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    const field = screen.getByLabelText("Hex");
    await field.fill("bogus");
    await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onChange).not.toHaveBeenCalled();
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("copies the hue onto another row on drop, keeping the target's opacity", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const rows = screen.getByRole("listitem").all();
    const source = rows[0].getByRole("button", { name: "Selected row color" });
    await userEvent.dragAndDrop(source, rows[1]);

    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ multiSelected: "#173a3621" });
    expect(rootStyle().getPropertyValue("--sel-multi-bg")).toBe("#173a3621");
    await expect
      .element(screen.getByRole("dialog", { name: "Selected row color" }))
      .not.toBeInTheDocument();
    await expect.element(source).toHaveAttribute("aria-expanded", "false");
  });

  it("does not save when the committed value equals the current one", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    await screen.getByRole("button", { name: "Selected row color" }).click();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets one override and clears its custom properties", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <AppearanceSettings settings={settings({ selected: "#ff000080" })} onChange={onChange} />,
    );
    rootStyle().setProperty("--sel-bg", "#ff000080");
    const rows = screen.getByRole("listitem").all();
    await expect.element(rows[1].getByRole("button", { name: "Reset" })).toBeDisabled();
    await rows[0].getByRole("button", { name: "Reset" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({});
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("");
  });

  it("resets everything at once", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <AppearanceSettings
        settings={settings({ selected: "#ff000080", diffAdded: "#11223344" })}
        onChange={onChange}
      />,
    );
    await screen.getByRole("button", { name: "Reset all to defaults" }).click();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({});
  });

  it("disables Reset all when nothing is overridden", async () => {
    const screen = await render(<AppearanceSettings settings={settings()} onChange={vi.fn()} />);
    await expect
      .element(screen.getByRole("button", { name: "Reset all to defaults" }))
      .toBeDisabled();
  });
});
