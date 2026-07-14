import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Toolbar } from "./Toolbar";

const noop = () => {};

const base = {
  running: false,
  busy: false,
  port: 8080,
  onPortChange: noop,
  onToggleProxy: noop,
  systemProxy: false,
  onToggleSystemProxy: noop,
  viewer: false,
  onLaunchViewer: noop,
  onInstallCa: noop,
  decode: true,
  onToggleDecode: noop,
  settingsReady: true,
  onOpenSettings: noop,
  onOpen: noop,
  onSaveSession: noop,
  onClear: noop,
  filter: "",
  onFilterChange: noop,
  onSaveFilter: noop,
  filterInputRef: { current: null },
} as const;

describe("Toolbar", () => {
  it("keeps Settings disabled until the durable startup snapshot is loaded", async () => {
    const screen = await render(<Toolbar {...base} settingsReady={false} />);
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
  });

  it("shows the proxy controls (and a New viewer button) in normal mode", async () => {
    const screen = await render(<Toolbar {...base} />);
    await expect.element(screen.getByRole("button", { name: "Start" })).toBeVisible();
    await expect.element(screen.getByText("System proxy: off")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "New viewer" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Viewer mode");
  });

  it("replaces the proxy controls with a viewer badge in viewer mode", async () => {
    const screen = await render(<Toolbar {...base} viewer />);
    const badge = screen.getByText("Viewer mode");
    await expect.element(badge).toBeVisible();
    await expect.element(badge).toHaveClass("viewer-badge");
    // The New viewer button stays available so a viewer can spawn more viewers.
    await expect.element(screen.getByRole("button", { name: "New viewer" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("System proxy");
    expect(screen.container.querySelector('input[type="number"]')).toBeNull();
    expect(screen.container.querySelector('button[title*="Stop the proxy"]')).toBeNull();
  });

  it("launches a viewer when the New viewer button is clicked", async () => {
    const onLaunchViewer = vi.fn();
    const screen = await render(<Toolbar {...base} onLaunchViewer={onLaunchViewer} />);
    await screen.getByRole("button", { name: "New viewer" }).click();
    expect(onLaunchViewer).toHaveBeenCalledOnce();
  });

  it("saves the filter on Ctrl+Enter in the filter bar, not on plain Enter", async () => {
    const onSaveFilter = vi.fn();
    const screen = await render(
      <Toolbar {...base} filter="host:api" onSaveFilter={onSaveFilter} />,
    );
    const input = screen.getByPlaceholder(/Filter —/);
    await input.click();
    await userEvent.keyboard("{Enter}");
    expect(onSaveFilter).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onSaveFilter).toHaveBeenCalledOnce();
  });

  it("lets Ctrl+Enter bubble so global shortcuts stay alive", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const screen = await render(<Toolbar {...base} onSaveFilter={vi.fn()} />);
      await screen.getByPlaceholder(/Filter —/).click();
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      const events = onWindowKey.mock.calls.map(([e]) => e as KeyboardEvent);
      expect(events.some((e) => e.ctrlKey && e.key === "Enter")).toBe(true);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });
});
