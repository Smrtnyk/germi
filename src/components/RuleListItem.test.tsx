import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RuleListItem } from "./AutoresponderPanel";
import type { RuleSummary } from "../types";

function rule(over: Partial<RuleSummary> = {}): RuleSummary {
  return {
    id: "r1",
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "GET", url: "https://example.com/users", urlMatch: "exact" },
    action: {
      kind: "respond",
      status: 200,
      contentType: "application/json",
      contentEncoding: null,
    },
    ...over,
  };
}

const handlers = {
  onSelect: vi.fn(),
  onOpen: vi.fn(),
  onToggle: vi.fn(),
  onContextMenu: vi.fn(),
  onDragStart: vi.fn(),
  onDragOver: vi.fn(),
  onDrop: vi.fn(),
  onDragEnd: vi.fn(),
};

describe("RuleListItem", () => {
  it("shows the method + host + path once, not the URL twice", async () => {
    const screen = await render(
      <RuleListItem
        rule={rule()}
        selected={false}
        poppedOut={false}
        hits={0}
        draggable
        dragOver={false}
        {...handlers}
      />,
    );
    await expect.element(screen.getByText("GET")).toBeVisible();
    await expect.element(screen.getByText("example.com")).toBeVisible();
    await expect.element(screen.getByText("/users")).toBeVisible();
    // The compact secondary line carries the action, not a second copy of the URL.
    await expect.element(screen.getByText("200 application/json")).toBeVisible();
  });

  it("colors the method badge by verb", async () => {
    const screen = await render(
      <RuleListItem
        rule={rule({ matcher: { method: "DELETE", url: "https://x.test/a", urlMatch: "exact" } })}
        selected={false}
        poppedOut={false}
        hits={0}
        draggable
        dragOver={false}
        {...handlers}
      />,
    );
    await expect.element(screen.getByText("DELETE")).toHaveClass("m-delete");
  });

  it("shows a bare path with no host", async () => {
    const screen = await render(
      <RuleListItem
        rule={rule({
          matcher: { method: "POST", url: "/api/login", urlMatch: "contains" },
        })}
        selected={false}
        poppedOut={false}
        hits={0}
        draggable
        dragOver={false}
        {...handlers}
      />,
    );
    await expect.element(screen.getByText("POST")).toBeVisible();
    await expect.element(screen.getByText("/api/login")).toBeVisible();
  });

  it("opens a window on double-click", async () => {
    const onOpen = vi.fn();
    const screen = await render(
      <RuleListItem
        rule={rule()}
        selected={false}
        poppedOut={false}
        hits={0}
        draggable
        dragOver={false}
        {...handlers}
        onOpen={onOpen}
      />,
    );
    await userEvent.dblClick(screen.getByText("/users"));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("marks a popped-out rule and disables its stale inline toggle", async () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const screen = await render(
      <RuleListItem
        rule={rule()}
        selected={false}
        poppedOut
        hits={0}
        draggable
        dragOver={false}
        {...handlers}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );
    await expect
      .element(screen.getByTitle("Open in a separate window", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("checkbox")).toBeDisabled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
