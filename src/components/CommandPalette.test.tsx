import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CommandPalette } from "./CommandPalette";

function baseActions() {
  return [
    { id: "save", label: "Save session", run: vi.fn() },
    { id: "open", label: "Open session", run: vi.fn() },
    { id: "clear", label: "Clear traffic", run: vi.fn() },
    { id: "reload", label: "Reload config", disabled: true, run: vi.fn() },
  ];
}

describe("CommandPalette", () => {
  it("renders enabled actions as buttons and omits disabled ones", async () => {
    const screen = await render(<CommandPalette actions={baseActions()} onClose={vi.fn()} />);
    await expect.element(screen.getByRole("button", { name: "Save session" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Open session" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Reload config" }))
      .not.toBeInTheDocument();
  });

  it("highlights the first item initially", async () => {
    const screen = await render(<CommandPalette actions={baseActions()} onClose={vi.fn()} />);
    await expect.element(screen.getByRole("button", { name: "Save session" })).toHaveClass("on");
  });

  it("moves the highlight down with ArrowDown and back up with ArrowUp", async () => {
    const screen = await render(<CommandPalette actions={baseActions()} onClose={vi.fn()} />);
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(screen.getByRole("button", { name: "Open session" })).toHaveClass("on");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(screen.getByRole("button", { name: "Save session" })).toHaveClass("on");
  });

  it("filters the list by the typed query", async () => {
    const screen = await render(<CommandPalette actions={baseActions()} onClose={vi.fn()} />);
    await screen.getByRole("textbox").fill("save");
    await expect.element(screen.getByRole("button", { name: "Save session" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open session" }))
      .not.toBeInTheDocument();
  });

  it("shows a message when nothing matches the query", async () => {
    const screen = await render(<CommandPalette actions={baseActions()} onClose={vi.fn()} />);
    await screen.getByRole("textbox").fill("zzz");
    await expect.element(screen.getByText("No matching commands")).toBeVisible();
  });

  it("runs the highlighted action and closes on Enter", async () => {
    const actions = baseActions();
    const onClose = vi.fn();
    await render(<CommandPalette actions={actions} onClose={onClose} />);
    await userEvent.keyboard("{Enter}");
    expect(actions[0].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("runs an action and closes when its button is clicked", async () => {
    const actions = baseActions();
    const onClose = vi.fn();
    const screen = await render(<CommandPalette actions={actions} onClose={onClose} />);
    await screen.getByRole("button", { name: "Open session" }).click();
    expect(actions[1].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
