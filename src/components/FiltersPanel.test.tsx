import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SavedFilter } from "../savedFilters";
import { FiltersPanel } from "./FiltersPanel";

type Props = ComponentProps<typeof FiltersPanel>;

function saved(overrides: Partial<SavedFilter> = {}): SavedFilter {
  return {
    id: "f1",
    query: "host:api",
    kinds: [],
    statuses: [],
    color: "#e879f9",
    highlight: true,
    ...overrides,
  };
}

function setValueBypassingReactTracker(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    filters: [],
    soloId: null,
    counts: new Map(),
    canSaveCurrent: false,
    onSaveCurrent: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onSolo: vi.fn(),
    ...overrides,
  };
}

describe("FiltersPanel", () => {
  it("explains itself when the list is empty and disables saving", async () => {
    const screen = await render(<FiltersPanel {...makeProps()} />);
    await expect.element(screen.getByText(/Saved filters keep a filter query/)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "+ Save current filter" }))
      .toBeDisabled();
  });

  it("saves the current filter on demand", async () => {
    const onSaveCurrent = vi.fn();
    const screen = await render(
      <FiltersPanel {...makeProps({ canSaveCurrent: true, onSaveCurrent })} />,
    );
    await screen.getByRole("button", { name: "+ Save current filter" }).click();
    expect(onSaveCurrent).toHaveBeenCalledOnce();
  });

  it("lists an entry with its label and live match count", async () => {
    const screen = await render(
      <FiltersPanel
        {...makeProps({
          filters: [saved({ kinds: ["xhr"] })],
          counts: new Map([["f1", 7]]),
        })}
      />,
    );
    await expect.element(screen.getByText("host:api xhr")).toBeVisible();
    await expect.element(screen.getByText("7")).toBeVisible();
  });

  it("shows a dash for entries whose count needs a backend scan", async () => {
    const screen = await render(
      <FiltersPanel
        {...makeProps({
          filters: [saved({ query: "body:secret" })],
          counts: new Map([["f1", null]]),
        })}
      />,
    );
    await expect.element(screen.getByText("–")).toBeVisible();
  });

  it("solos an entry and un-solos it from the same toggle", async () => {
    const onSolo = vi.fn();
    const first = await render(<FiltersPanel {...makeProps({ filters: [saved()], onSolo })} />);
    await first.getByRole("button", { name: "only" }).click();
    expect(onSolo).toHaveBeenCalledWith("f1");
    await first.unmount();

    const second = await render(
      <FiltersPanel {...makeProps({ filters: [saved()], soloId: "f1", onSolo })} />,
    );
    const toggle = second.getByRole("button", { name: "only" });
    await expect.element(toggle).toHaveClass("on");
    await toggle.click();
    expect(onSolo).toHaveBeenLastCalledWith(null);
  });

  it("toggles highlighting off through onUpdate", async () => {
    const onUpdate = vi.fn();
    const screen = await render(<FiltersPanel {...makeProps({ filters: [saved()], onUpdate })} />);
    const toggle = screen.getByRole("button", { name: "highlight" });
    await expect.element(toggle).toHaveClass("on");
    await toggle.click();
    expect(onUpdate).toHaveBeenCalledWith("f1", { highlight: false });
  });

  it("removes an entry", async () => {
    const onRemove = vi.fn();
    const screen = await render(<FiltersPanel {...makeProps({ filters: [saved()], onRemove })} />);
    await screen.getByRole("button", { name: "Remove filter host:api" }).click();
    expect(onRemove).toHaveBeenCalledWith("f1");
  });

  it("expands into an editor that live-updates the query and chips", async () => {
    const onUpdate = vi.fn();
    const screen = await render(<FiltersPanel {...makeProps({ filters: [saved()], onUpdate })} />);
    await screen.getByRole("button", { name: "host:api", exact: true }).click();

    const query = screen.getByRole("textbox", { name: "Filter query" });
    await expect.element(query).toBeVisible();
    await query.fill("host:api status:4xx");
    expect(onUpdate).toHaveBeenCalledWith("f1", { query: "host:api status:4xx" });

    await screen.getByRole("button", { name: "Doc" }).click();
    expect(onUpdate).toHaveBeenCalledWith("f1", { kinds: ["doc"] });
  });

  it("warns inside the editor when the query has content terms", async () => {
    const screen = await render(
      <FiltersPanel {...makeProps({ filters: [saved({ query: "body:secret" })] })} />,
    );
    await screen.getByRole("button", { name: "body:secret", exact: true }).click();
    await expect.element(screen.getByText(/row highlights/)).toBeVisible();
  });

  it("changes the color through the picker", async () => {
    const onUpdate = vi.fn();
    const screen = await render(<FiltersPanel {...makeProps({ filters: [saved()], onUpdate })} />);
    const picker = screen.getByLabelText("Highlight color").element() as HTMLInputElement;
    setValueBypassingReactTracker(picker, "#123456");
    expect(onUpdate).toHaveBeenCalledWith("f1", { color: "#123456" });
  });

  it("disables the highlight toggle for body:/header: filters", async () => {
    const screen = await render(
      <FiltersPanel {...makeProps({ filters: [saved({ query: "body:secret" })] })} />,
    );
    const toggle = screen.getByRole("button", { name: "highlight" });
    await expect.element(toggle).toBeDisabled();
    await expect.element(toggle).not.toHaveClass("on");
  });
});
