import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StatusBar } from "./StatusBar";

const noop = () => {};

const base = {
  running: true,
  port: 8888,
  allowRemote: false,
  viewer: false,
  flowCount: 0,
  activeScenario: null,
  generalActive: false,
  onOpenPalette: noop,
  onShowShortcuts: noop,
  paletteAccel: "Ctrl+K",
} as const;

describe("StatusBar", () => {
  it("shows the loopback host and an on state while running locally", async () => {
    const screen = await render(<StatusBar {...base} />);
    const stat = screen.getByText(/Listening on 127\.0\.0\.1:8888/);
    await expect.element(stat).toBeVisible();
    await expect.element(stat).toHaveClass("on");
  });

  it("shows the wildcard host when remote access is allowed", async () => {
    const screen = await render(<StatusBar {...base} allowRemote />);
    await expect.element(screen.getByText(/Listening on 0\.0\.0\.0:8888/)).toBeVisible();
  });

  it("reports a stopped proxy when not running", async () => {
    const screen = await render(<StatusBar {...base} running={false} />);
    await expect.element(screen.getByText("Stopped")).toBeVisible();
  });

  it("shows a viewer state instead of proxy status in viewer mode", async () => {
    const screen = await render(<StatusBar {...base} running={false} viewer />);
    const stat = screen.getByText("Viewer mode");
    await expect.element(stat).toBeVisible();
    await expect.element(stat).toHaveClass("viewer");
    expect(screen.container.textContent).not.toContain("Stopped");
    expect(screen.container.textContent).not.toContain("Listening");
    // The autoresponder is disabled in viewer mode, so its segment is hidden.
    expect(screen.container.textContent).not.toContain("Autoresponder");
  });

  it("displays the captured flow count", async () => {
    const screen = await render(<StatusBar {...base} flowCount={42} />);
    await expect.element(screen.getByText("42 flows")).toBeVisible();
  });

  it("names the active autoresponder scenario when one is set", async () => {
    const screen = await render(<StatusBar {...base} activeScenario="Prod" />);
    await expect.element(screen.getByText("Prod")).toBeVisible();
  });

  it("falls back to Off when no scenario is active and General is off", async () => {
    const screen = await render(<StatusBar {...base} />);
    await expect.element(screen.getByText("Off")).toBeVisible();
  });

  it("surfaces the General rules layer when it is enabled with no active scenario", async () => {
    const screen = await render(<StatusBar {...base} generalActive />);
    await expect.element(screen.getByText("General rules")).toBeVisible();
    // General on ⇒ the autoresponder is not "Off".
    expect(screen.container.textContent).not.toContain("Off");
  });

  it("shows both the active scenario and the General layer when both are live", async () => {
    const screen = await render(<StatusBar {...base} activeScenario="Prod" generalActive />);
    await expect.element(screen.getByText("Prod")).toBeVisible();
    await expect.element(screen.getByText("General rules")).toBeVisible();
  });

  it("opens the command palette when the palette key is clicked", async () => {
    const onOpenPalette = vi.fn();
    const screen = await render(<StatusBar {...base} onOpenPalette={onOpenPalette} />);
    await screen.getByRole("button", { name: "⌘K" }).click();
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it("shows the shortcuts overlay when the help key is clicked", async () => {
    const onShowShortcuts = vi.fn();
    const screen = await render(<StatusBar {...base} onShowShortcuts={onShowShortcuts} />);
    await screen.getByRole("button", { name: "?" }).click();
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("surfaces the configured palette accelerator in the key tooltip", async () => {
    const screen = await render(<StatusBar {...base} />);
    await expect.element(screen.getByTitle(/Ctrl\+K/)).toBeVisible();
  });
});
