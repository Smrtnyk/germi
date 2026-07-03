import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { delay } from "es-toolkit";

import "../styles.css";
import { HIGHLIGHT_COLORS } from "../theme";
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
  it("renders a picker, slider and readout per highlight color", async () => {
    const screen = await render(<AppearanceSettings settings={settings()} onChange={vi.fn()} />);
    await expect.element(screen.getByText("Traffic rows")).toBeVisible();
    await expect.element(screen.getByText("Compare & diff")).toBeVisible();
    for (const s of HIGHLIGHT_COLORS) {
      await expect
        .element(screen.getByRole("slider", { name: `${s.label} opacity` }))
        .toBeVisible();
    }
    await expect.element(screen.getByText("13%")).toBeVisible();
  });

  it("commits a slider change once, on release, and applies the override", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Selected row opacity" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ selected: "#173a36fc" });
    expect(rootStyle().getPropertyValue("--sel-bg")).toBe("#173a36fc");
  });

  it("commits a picker change keeping the row's opacity and derives the diff mark", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const picker = screen.getByLabelText("Diff — added lines color");
    await setColorInput(picker.element() as HTMLInputElement, "#112233");
    expect(onChange.mock.calls[0][0].highlightColors).toEqual({ diffAdded: "#11223317" });
    expect(rootStyle().getPropertyValue("--diff-add-bg")).toBe("#11223317");
    expect(rootStyle().getPropertyValue("--diff-add-hl")).toBe("#11223345");
  });

  it("does not save when the committed value equals the current one", async () => {
    const onChange = vi.fn();
    const screen = await render(<AppearanceSettings settings={settings()} onChange={onChange} />);
    const picker = screen.getByLabelText("Selected row color");
    await setColorInput(picker.element() as HTMLInputElement, "#173a36");
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
