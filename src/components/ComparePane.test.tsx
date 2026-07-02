import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComparePane, type ComparePaneProps } from "./ComparePane";
import { summary } from "../flowFixtures";

function paneProps(overrides: Partial<ComparePaneProps> = {}): ComparePaneProps {
  return {
    title: "A — yours",
    emptyHint: "Nothing here yet",
    flows: [
      summary({ id: "f1", host: "api.test", path: "/users?page=1" }),
      summary({ id: "f2", host: "api.test", path: "/orders", method: "POST", status: 500 }),
    ],
    selectedId: "f1",
    active: true,
    matches: null,
    onSelect: vi.fn(),
    onMove: vi.fn(),
    moveHint: "move across",
    ...overrides,
  };
}

describe("ComparePane", () => {
  it("renders the title, count, and one row per flow", async () => {
    const screen = await render(<ComparePane {...paneProps()} />);
    await expect.element(screen.getByText("A — yours")).toBeVisible();
    await expect.element(screen.getByText("2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("/users?page=1")).toBeVisible();
    await expect.element(screen.getByText("/orders")).toBeVisible();
  });

  it("marks only the selected row and tones the status code", async () => {
    const screen = await render(<ComparePane {...paneProps()} />);
    const selected = screen.getByTitle(/users/);
    await expect.element(selected).toHaveClass("selected");
    await expect.element(screen.getByText("500")).toHaveClass("s5");
  });

  it("shows a % badge per row when the other side has a selection", async () => {
    const matches = new Map([
      ["f1", 95],
      ["f2", 34],
    ]);
    const screen = await render(<ComparePane {...paneProps({ matches })} />);
    await expect.element(screen.getByText("95%")).toHaveClass("high");
    await expect.element(screen.getByText("34%")).toHaveClass("low");
  });

  it("selects on click and moves on double-click", async () => {
    const onSelect = vi.fn();
    const onMove = vi.fn();
    const screen = await render(<ComparePane {...paneProps({ onSelect, onMove })} />);
    const row = screen.getByTitle(/orders/);
    await row.click();
    expect(onSelect).toHaveBeenCalledWith("f2");
    await row.dblClick();
    expect(onMove).toHaveBeenCalledWith("f2");
  });

  it("shows the empty hint and pane actions when there are no rows", async () => {
    const screen = await render(
      <ComparePane
        {...paneProps({ flows: [], selectedId: null })}
        actions={<button type="button">Load file…</button>}
      />,
    );
    await expect.element(screen.getByText("Nothing here yet")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Load file…" })).toBeVisible();
  });
});
