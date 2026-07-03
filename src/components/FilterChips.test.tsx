import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ResourceKind } from "../types";
import { FilterChips, type FilterViewControls } from "./FilterChips";

type Props = ComponentProps<typeof FilterChips>;

function makeView(overrides: Partial<FilterViewControls> = {}): FilterViewControls {
  return {
    mode: "hide",
    onMode: vi.fn(),
    accel: "Ctrl / ⌘ H",
    barActive: false,
    onSave: vi.fn(),
    solo: null,
    onClearSolo: vi.fn(),
    ...overrides,
  };
}

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    typeChips: new Set<ResourceKind>(),
    statusChips: new Set<string>(),
    onToggleType: vi.fn(),
    onToggleStatus: vi.fn(),
    onClearAll: vi.fn(),
    filter: "",
    onFilterChange: vi.fn(),
    searching: false,
    matchCount: null,
    total: 0,
    view: makeView(),
    onCheckAvailability: vi.fn(),
    availabilityCheck: null,
    capturedDelete: { capturedCount: 0, importedCount: 0, onDelete: vi.fn() },
    ...overrides,
  };
}

describe("FilterChips", () => {
  it("renders a status chip and reports a toggle with its status", async () => {
    const onToggleStatus = vi.fn();
    const screen = await render(<FilterChips {...makeProps({ onToggleStatus })} />);
    const chip = screen.getByRole("button", { name: "2xx" });
    await expect.element(chip).toBeVisible();
    await chip.click();
    expect(onToggleStatus).toHaveBeenCalledWith("2xx");
  });

  it("marks a selected status chip with the on class", async () => {
    const screen = await render(<FilterChips {...makeProps({ statusChips: new Set(["4xx"]) })} />);
    await expect.element(screen.getByRole("button", { name: "4xx" })).toHaveClass("on");
    await expect.element(screen.getByRole("button", { name: "2xx" })).not.toHaveClass("on");
  });

  it("reports the kind when a type chip is clicked", async () => {
    const onToggleType = vi.fn();
    const screen = await render(<FilterChips {...makeProps({ onToggleType })} />);
    await screen.getByRole("button", { name: "Doc" }).click();
    expect(onToggleType).toHaveBeenCalledWith("doc");
  });

  it("renders a removable pill per filter term and drops the clicked one", async () => {
    const onFilterChange = vi.fn();
    const screen = await render(
      <FilterChips {...makeProps({ filter: "foo bar", onFilterChange })} />,
    );
    await expect.element(screen.getByText("terms")).toBeVisible();
    await expect.element(screen.getByText("bar")).toBeVisible();
    await screen.getByText("foo").click();
    expect(onFilterChange).toHaveBeenCalledWith("bar");
  });

  it("hides the clear button and match count when no filter is active", async () => {
    const screen = await render(<FilterChips {...makeProps({ matchCount: null, total: 7 })} />);
    const clear = screen.getByRole("button", { name: "Clear filters" });
    await expect.element(clear).not.toBeInTheDocument();
    await expect.element(screen.getByText(/match/i)).not.toBeInTheDocument();
  });

  it("shows a no-matches message when the filter matches nothing", async () => {
    const screen = await render(<FilterChips {...makeProps({ matchCount: 0, total: 9 })} />);
    await expect.element(screen.getByText("no matches of 9")).toBeVisible();
  });

  it("shows the match count and clears all filters on demand", async () => {
    const onClearAll = vi.fn();
    const screen = await render(
      <FilterChips {...makeProps({ matchCount: 5, total: 10, onClearAll })} />,
    );
    await expect.element(screen.getByText("5 of 10 match")).toBeVisible();
    await screen.getByRole("button", { name: "Clear filters" }).click();
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it("surfaces the live searching hint", async () => {
    const screen = await render(<FilterChips {...makeProps({ searching: true })} />);
    await expect.element(screen.getByText("searching…")).toBeVisible();
  });

  it("enables the availability check and runs it when clicked", async () => {
    const onCheckAvailability = vi.fn();
    const screen = await render(<FilterChips {...makeProps({ onCheckAvailability })} />);
    const btn = screen.getByRole("button", { name: "Check availability" });
    await expect.element(btn).not.toBeDisabled();
    await btn.click();
    expect(onCheckAvailability).toHaveBeenCalledOnce();
  });

  it("shows progress and disables the availability check while running", async () => {
    const availabilityCheck = { completed: 2, total: 5 };
    const screen = await render(<FilterChips {...makeProps({ availabilityCheck })} />);
    await expect.element(screen.getByRole("button", { name: "Checking 2/5…" })).toBeDisabled();
  });

  it("shows the delete-captured action and prunes on click", async () => {
    const onDelete = vi.fn();
    const capturedDelete = { capturedCount: 3, importedCount: 2, onDelete };
    const screen = await render(<FilterChips {...makeProps({ capturedDelete })} />);
    await screen.getByRole("button", { name: "Delete captured (3)" }).click();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("hides the delete-captured action without any imported flows", async () => {
    const capturedDelete = { capturedCount: 5, importedCount: 0, onDelete: vi.fn() };
    const screen = await render(<FilterChips {...makeProps({ capturedDelete })} />);
    const btn = screen.getByRole("button", { name: /Delete captured/ });
    await expect.element(btn).not.toBeInTheDocument();
  });

  it("shows the Hide/Dim switch only while the bar filter is active", async () => {
    const soloOnly = await render(
      <FilterChips {...makeProps({ matchCount: 3, total: 5, view: makeView() })} />,
    );
    await expect.element(soloOnly.getByRole("button", { name: "Hide" })).not.toBeInTheDocument();
    await soloOnly.unmount();

    const onMode = vi.fn();
    const view = makeView({ barActive: true, onMode });
    const screen = await render(<FilterChips {...makeProps({ matchCount: 3, total: 5, view })} />);
    await expect.element(screen.getByRole("button", { name: "Hide" })).toHaveClass("on");
    await screen.getByRole("button", { name: "Dim" }).click();
    expect(onMode).toHaveBeenCalledWith("dim");
  });

  it("offers Save filter when the bar holds something and reports the save", async () => {
    const onSave = vi.fn();
    const view = makeView({ barActive: true, onSave });
    const screen = await render(<FilterChips {...makeProps({ matchCount: 2, total: 4, view })} />);
    await screen.getByRole("button", { name: "+ Save filter" }).click();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("hides Save filter when there is nothing to save", async () => {
    const screen = await render(<FilterChips {...makeProps()} />);
    await expect
      .element(screen.getByRole("button", { name: "+ Save filter" }))
      .not.toBeInTheDocument();
  });

  it("names the solo'd filter in an only-chip and clears it on click", async () => {
    const onClearSolo = vi.fn();
    const view = makeView({ solo: { label: "host:api 4xx", color: "#e879f9" }, onClearSolo });
    const screen = await render(<FilterChips {...makeProps({ matchCount: 1, total: 9, view })} />);
    const chip = screen.getByRole("button", { name: /only: host:api 4xx/ });
    await expect.element(chip).toBeVisible();
    await chip.click();
    expect(onClearSolo).toHaveBeenCalledOnce();
  });
});
