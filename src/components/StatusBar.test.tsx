import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StatusBar } from "./StatusBar";

const noop = () => {};

describe("StatusBar", () => {
  it("shows the loopback host and an on state while running locally", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    const stat = screen.getByText(/Listening on 127\.0\.0\.1:8888/);
    await expect.element(stat).toBeVisible();
    await expect.element(stat).toHaveClass("on");
  });

  it("shows the wildcard host when remote access is allowed", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByText(/Listening on 0\.0\.0\.0:8888/)).toBeVisible();
  });

  it("reports a stopped proxy when not running", async () => {
    const screen = await render(
      <StatusBar
        running={false}
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByText("Stopped")).toBeVisible();
  });

  it("displays the captured flow count", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={42}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByText("42 flows")).toBeVisible();
  });

  it("names the active autoresponder scenario when one is set", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario="Prod"
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByText("Prod")).toBeVisible();
  });

  it("falls back to Off when no scenario is active", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByText("Off")).toBeVisible();
  });

  it("opens the command palette when the palette key is clicked", async () => {
    const onOpenPalette = vi.fn();
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={onOpenPalette}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await screen.getByRole("button", { name: "⌘K" }).click();
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it("shows the shortcuts overlay when the help key is clicked", async () => {
    const onShowShortcuts = vi.fn();
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={onShowShortcuts}
        paletteAccel="Ctrl+K"
      />,
    );
    await screen.getByRole("button", { name: "?" }).click();
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("surfaces the configured palette accelerator in the key tooltip", async () => {
    const screen = await render(
      <StatusBar
        running
        port={8888}
        allowRemote={false}
        flowCount={0}
        activeScenario={null}
        onOpenPalette={noop}
        onShowShortcuts={noop}
        paletteAccel="Ctrl+K"
      />,
    );
    await expect.element(screen.getByTitle(/Ctrl\+K/)).toBeVisible();
  });
});
