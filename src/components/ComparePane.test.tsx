import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { ComparePane, type ComparePaneProps } from "./ComparePane";
import { emptyPaneQuery, selectOnly } from "../comparePane";
import { summary } from "../flowFixtures";

function paneProps(overrides: Partial<ComparePaneProps> = {}): ComparePaneProps {
  return {
    title: "A — yours",
    emptyHint: "Nothing here yet",
    rows: [
      summary({ id: "f1", seq: 1, host: "api.test", path: "/users?page=1" }),
      summary({ id: "f2", seq: 2, host: "api.test", path: "/orders", method: "POST", status: 500 }),
    ],
    total: 2,
    selection: selectOnly("f1"),
    active: true,
    matches: null,
    tint: "a",
    query: emptyPaneQuery(),
    onFilterChange: vi.fn(),
    onToggleKind: vi.fn(),
    onToggleSort: vi.fn(),
    onRowClick: vi.fn(),
    onRowMove: vi.fn(),
    moveHint: "move across",
    ...overrides,
  };
}

describe("ComparePane", () => {
  it("renders the title, count, column headers, and one row per flow", async () => {
    const screen = await render(<ComparePane {...paneProps()} />);
    await expect.element(screen.getByText("A — yours")).toBeVisible();
    await expect.element(screen.getByText("2", { exact: true }).first()).toBeVisible();
    await expect.element(screen.getByTitle("Sort by Match")).toBeVisible();
    await expect.element(screen.getByText("/users?page=1")).toBeVisible();
    await expect.element(screen.getByText("/orders")).toBeVisible();
  });

  it("marks the focused row and every multi-selected row", async () => {
    const screen = await render(
      <ComparePane
        {...paneProps({
          selection: { selectedIds: new Set(["f1", "f2"]), focusedId: "f1", anchorId: "f1" },
        })}
      />,
    );
    const focused = screen.getByTitle(/users/);
    await expect.element(focused).toHaveClass("selected");
    await expect.element(screen.getByTitle(/orders/)).toHaveClass("checked");
  });

  it("tints good-match rows with the pane's color and tones the badge", async () => {
    const matches = new Map([
      ["f1", 95],
      ["f2", 34],
    ]);
    const screen = await render(<ComparePane {...paneProps({ matches, tint: "b" })} />);
    await expect.element(screen.getByText("95%")).toHaveClass("high");
    await expect.element(screen.getByTitle(/users/)).toHaveClass("hit-b");
    await expect.element(screen.getByTitle(/orders/)).not.toHaveClass("hit-b");
  });

  it("reports clicks with their mouse event and double-clicks as moves", async () => {
    const onRowClick = vi.fn();
    const onRowMove = vi.fn();
    const screen = await render(<ComparePane {...paneProps({ onRowClick, onRowMove })} />);
    const row = screen.getByTitle(/orders/);
    await row.click();
    expect(onRowClick).toHaveBeenCalledWith("f2", expect.anything());
    await row.dblClick();
    expect(onRowMove).toHaveBeenCalledWith("f2");
  });

  it("forwards filter typing, kind chips, and sort clicks", async () => {
    const onFilterChange = vi.fn();
    const onToggleKind = vi.fn();
    const onToggleSort = vi.fn();
    const screen = await render(
      <ComparePane {...paneProps({ onFilterChange, onToggleKind, onToggleSort })} />,
    );
    await screen.getByPlaceholder(/Filter/).fill("api");
    expect(onFilterChange).toHaveBeenCalledWith("api");
    await screen.getByRole("button", { name: "Fetch/XHR" }).click();
    expect(onToggleKind).toHaveBeenCalledWith("xhr");
    await screen.getByTitle("Sort by Status").click();
    expect(onToggleSort).toHaveBeenCalledWith("status");
  });

  it("shows the n-of-m count and a no-matches hint when the filter hides everything", async () => {
    const screen = await render(
      <ComparePane {...paneProps({ rows: [], total: 2, selection: selectOnly(null) })} />,
    );
    await expect.element(screen.getByText("0 of 2")).toBeVisible();
    await expect.element(screen.getByText("Nothing matches the filter")).toBeVisible();
    await expect.element(page.getByText("Nothing here yet")).not.toBeInTheDocument();
  });

  it("shows the empty hint and pane actions when the pane has no rows at all", async () => {
    const screen = await render(
      <ComparePane
        {...paneProps({ rows: [], total: 0, selection: selectOnly(null) })}
        actions={<button type="button">Load file…</button>}
      />,
    );
    await expect.element(screen.getByText("Nothing here yet")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Load file…" })).toBeVisible();
  });
});
