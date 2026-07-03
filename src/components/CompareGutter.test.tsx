import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CompareGutter, type CompareGutterProps } from "./CompareGutter";

function gutterProps(overrides: Partial<CompareGutterProps> = {}): CompareGutterProps {
  return {
    linked: true,
    canMoveRight: true,
    canMoveLeft: true,
    onToggleLinked: vi.fn(),
    onCopyFilter: vi.fn(),
    onMoveRight: vi.fn(),
    onMoveLeft: vi.fn(),
    ...overrides,
  };
}

describe("CompareGutter", () => {
  it("shows the linked state and disables the manual copies while linked", async () => {
    const screen = await render(<CompareGutter {...gutterProps()} />);
    await expect.element(screen.getByTitle(/Filters are linked/)).toBeVisible();
    await expect
      .element(screen.getByTitle("Copy the left filter to the right side"))
      .toBeDisabled();
    await expect
      .element(screen.getByTitle("Copy the right filter to the left side"))
      .toBeDisabled();
  });

  it("reports link toggles", async () => {
    const onToggleLinked = vi.fn();
    const screen = await render(
      <CompareGutter {...gutterProps({ linked: false, onToggleLinked })} />,
    );
    await screen.getByTitle(/Link the filters/).click();
    expect(onToggleLinked).toHaveBeenCalledTimes(1);
  });

  it("copies either side's filter across when unlinked", async () => {
    const onCopyFilter = vi.fn();
    const screen = await render(
      <CompareGutter {...gutterProps({ linked: false, onCopyFilter })} />,
    );
    await screen.getByTitle("Copy the left filter to the right side").click();
    expect(onCopyFilter).toHaveBeenCalledWith("left");
    await screen.getByTitle("Copy the right filter to the left side").click();
    expect(onCopyFilter).toHaveBeenCalledWith("right");
  });

  it("keeps the move buttons wired and disabled without a source selection", async () => {
    const onMoveRight = vi.fn();
    const screen = await render(
      <CompareGutter {...gutterProps({ canMoveLeft: false, onMoveRight })} />,
    );
    await screen.getByTitle("Move the selected requests to the right side (→)").click();
    expect(onMoveRight).toHaveBeenCalledTimes(1);
    await expect
      .element(screen.getByTitle("Move the selected requests back to the left side (←)"))
      .toBeDisabled();
  });
});
