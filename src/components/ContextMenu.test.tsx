import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";

describe("ContextMenu", () => {
  it("renders each non-separator item as a menuitem button by its label", async () => {
    const items: MenuItem[] = [
      { label: "Copy", onClick: vi.fn() },
      { label: "Paste", onClick: vi.fn() },
    ];
    const screen = await render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    await expect.element(screen.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "Paste" })).toBeVisible();
  });

  it("calls the item's onClick once and onClose once when clicked", async () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [{ label: "Run", onClick }];
    const screen = await render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    await screen.getByRole("menuitem", { name: "Run" }).click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables a disabled item and swallows its click", async () => {
    const onClick = vi.fn();
    const items: MenuItem[] = [{ label: "Nope", onClick, disabled: true }];
    const screen = await render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    const item = screen.getByRole("menuitem", { name: "Nope" });
    await expect.element(item).toBeDisabled();
    await item.click({ force: true }).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("marks a danger item's button with the danger class", async () => {
    const items: MenuItem[] = [{ label: "Delete", onClick: vi.fn(), danger: true }];
    const screen = await render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    await expect.element(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("danger");
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const items: MenuItem[] = [{ label: "Copy", onClick: vi.fn() }];
    await render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clamps the menu inside the viewport for off-screen coordinates", async () => {
    const items: MenuItem[] = [{ label: "Copy", onClick: vi.fn() }];
    const screen = await render(
      <ContextMenu x={99999} y={99999} items={items} onClose={vi.fn()} />,
    );
    const el = screen.getByRole("menu").element() as HTMLElement;
    expect(parseFloat(el.style.left)).toBeLessThan(window.innerWidth);
    expect(parseFloat(el.style.top)).toBeLessThan(window.innerHeight);
  });

  it("renders a separator item as a ctx-sep divider", async () => {
    const items: MenuItem[] = [
      { label: "Copy", onClick: vi.fn() },
      { label: "", onClick: vi.fn(), sep: true },
      { label: "Paste", onClick: vi.fn() },
    ];
    await render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    expect(document.querySelector(".ctx-sep")).toBeTruthy();
  });
});
