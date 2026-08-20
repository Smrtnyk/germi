import { StrictMode, useState } from "react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { FilterSaveResult } from "../filterWindowProtocol";
import { DEFAULT_FILTER_COLOR_PRESETS, filterColorPresetParts } from "../filterColorPresets";
import { DEFAULT_FILTER_OPACITY, type FilterDraft, type SavedFilter } from "../savedFilters";
import { FilterWindowView } from "./FilterWindowView";
import "../styles.css";

const initialDraft: FilterDraft = {
  query: "host:current.example",
  kinds: ["doc"],
  statuses: [],
  color: "#e879f9",
  opacity: DEFAULT_FILTER_OPACITY,
  highlight: true,
};

function result(ok: boolean, error = "save failed"): FilterSaveResult {
  return ok
    ? { sessionId: "session", requestId: "request", ok: true }
    : { sessionId: "session", requestId: "request", ok: false, error };
}

function saved(overrides: Partial<SavedFilter> = {}): SavedFilter {
  return {
    id: "saved-1",
    query: "host:api",
    kinds: [],
    statuses: [],
    color: "#fbbf24",
    opacity: DEFAULT_FILTER_OPACITY,
    highlight: true,
    ...overrides,
  };
}

interface HarnessProps {
  draft?: FilterDraft;
  existingFilters?: SavedFilter[];
  colorPresets?: Parameters<typeof FilterWindowView>[0]["colorPresets"];
  onSave?: (draft: FilterDraft, only: boolean) => Promise<FilterSaveResult>;
  onPreview?: (draft: FilterDraft, only: boolean) => void;
  onCancel?: () => void;
}

function Harness({
  draft: startingDraft = initialDraft,
  existingFilters = [],
  colorPresets = filterColorPresetParts(DEFAULT_FILTER_COLOR_PRESETS),
  onSave = () => Promise.resolve(result(true)),
  onPreview = () => {},
  onCancel = () => {},
}: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(startingDraft);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open filter builder</button>
      {open && (
        <FilterWindowView
          draft={draft}
          existingFilters={existingFilters}
          colorPresets={colorPresets}
          windowError={null}
          onChange={setDraft}
          onPreviewChange={onPreview}
          onSave={async (next, only) => {
            const outcome = await onSave(next, only);
            if (outcome.ok) setOpen(false);
            return outcome;
          }}
          onSavingChange={() => {}}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe("FilterWindowView", () => {
  it("uses native labelled controls, accessible mode pills, and initial query focus", async () => {
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await expect.element(screen.getByLabelText("Manual query")).toHaveValue("host:current.example");
    await expect.element(screen.getByLabelText("Manual query")).toHaveFocus();
    await expect.element(screen.getByLabelText("Search text")).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Side", exact: true }))
      .toHaveValue("both");
    await expect
      .element(screen.getByRole("combobox", { name: "Part", exact: true }))
      .toHaveValue("content");
    await expect
      .element(screen.getByRole("button", { name: "Highlight", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: "Only", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("input[type=checkbox]")).toBeNull();
  });

  it("replaces one safely quoted guided term without modifying manual syntax", async () => {
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByLabelText("Search text").fill(' trace "id" \\ path ');
    await expect
      .element(screen.getByText('host:current.example content:"trace \\"id\\" \\\\ path"'))
      .toBeVisible();
    await expect.element(screen.getByLabelText("Manual query")).toHaveValue("host:current.example");
    await screen.getByRole("combobox", { name: "Side", exact: true }).selectOptions("request");
    await expect
      .element(screen.getByText('host:current.example req-content:"trace \\"id\\" \\\\ path"'))
      .toBeVisible();
    await screen.getByRole("combobox", { name: "Part", exact: true }).selectOptions("headers");
    await expect
      .element(screen.getByText('host:current.example req-header:"trace \\"id\\" \\\\ path"'))
      .toBeVisible();
    await screen.getByLabelText("Search text").fill("replacement");
    await expect
      .element(screen.getByText('host:current.example req-header:"replacement"'))
      .toBeVisible();
    expect(document.body.textContent).not.toContain('trace \\"id');
  });

  it("streams highlight, only, effective query, hue, and opacity before save", async () => {
    const onPreview = vi.fn();
    const onSave = vi.fn(() => Promise.resolve(result(true)));
    const screen = await render(<Harness onPreview={onPreview} onSave={onSave} />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByLabelText("Search text").fill("needle");
    await screen.getByRole("button", { name: "Only", exact: true }).click();
    await screen.getByRole("button", { name: "Highlight", exact: true }).click();
    const color = screen.getByRole("button", { name: "Highlight color" });
    await color.click();
    await screen.getByLabelText("Hex").fill("#00ff00");
    await screen.getByRole("slider", { name: "Highlight opacity" }).fill("40");
    await vi.waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: 'host:current.example content:"needle"',
          color: "#00ff00",
          opacity: 40,
          highlight: false,
        }),
        true,
      ),
    );
    await screen
      .getByRole("dialog", { name: "Highlight color" })
      .getByRole("button", { name: "Apply" })
      .click();
    await screen.getByRole("button", { name: "Save filter" }).click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        query: 'host:current.example content:"needle"',
        color: "#00ff00",
        opacity: 40,
        highlight: false,
      }),
      true,
    );
  });

  it("reverts an uncommitted picker preview and lets help consume Escape first", async () => {
    const onPreview = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(<Harness onPreview={onPreview} onCancel={onCancel} />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByRole("button", { name: "Highlight color" }).click();
    await screen.getByLabelText("Hex").fill("#00ff0080");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ color: initialDraft.color, opacity: initialDraft.opacity }),
        false,
      ),
    );
    expect(onCancel).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Filter syntax help" }).click();
    await expect.element(screen.getByRole("button", { name: "content:" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps invalid, duplicate, and rejected saves visible", async () => {
    const onSave = vi.fn(() =>
      Promise.resolve(result(false, "The main window rejected this save.")),
    );
    const screen = await render(
      <Harness
        draft={{ ...initialDraft, query: "", kinds: [] }}
        existingFilters={[saved()]}
        onSave={onSave}
      />,
    );
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByRole("button", { name: "Save filter" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Add a query, resource type, or status before saving.");
    await screen.getByLabelText("Manual query").fill("host:api");
    await screen.getByRole("button", { name: "Save filter" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This filter is already saved as “host:api”.");
    await screen.getByLabelText("Manual query").fill("host:new");
    await screen.getByRole("button", { name: "Save filter" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The main window rejected this save.");
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("locks the saved draft and exposes only close retry after destruction fails", async () => {
    const onSave = vi.fn(() =>
      Promise.resolve<FilterSaveResult>({
        sessionId: "session",
        requestId: "request",
        ok: false,
        error: "The filter was saved, but its window could not close.",
        saved: true,
      }),
    );
    const screen = await render(<Harness onSave={onSave} />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();

    await screen.getByRole("button", { name: "Save filter" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The filter was saved, but its window could not close.");
    await expect.element(screen.getByLabelText("Manual query")).toBeDisabled();
    await expect.element(screen.getByLabelText("Search text")).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Retry close" })).toBeVisible();
  });

  it("consumes Escape while one save is in flight", async () => {
    let finish!: (outcome: FilterSaveResult) => void;
    const onSave = vi.fn(
      () =>
        new Promise<FilterSaveResult>((resolve) => {
          finish = resolve;
        }),
    );
    const onCancel = vi.fn();
    const screen = await render(<Harness onSave={onSave} onCancel={onCancel} />);
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByRole("button", { name: "Save filter" }).click();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish(result(true));
    await expect
      .element(screen.getByRole("heading", { name: "Create saved filter" }))
      .not.toBeInTheDocument();
  });

  it("renders an async save failure under StrictMode", async () => {
    const onSave = vi.fn(() => Promise.resolve(result(false, "StrictMode save was rejected.")));
    const screen = await render(
      <StrictMode>
        <Harness onSave={onSave} />
      </StrictMode>,
    );
    await screen.getByRole("button", { name: "Open filter builder" }).click();
    await screen.getByRole("button", { name: "Save filter" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("StrictMode save was rejected.");
  });
});
