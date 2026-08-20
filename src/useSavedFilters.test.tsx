import { delay } from "es-toolkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { SavedFilter } from "./savedFilters";
import { useSavedFilters } from "./useSavedFilters";
import type { FlowSummary } from "./types";

const FILTERS_KEY = "germi.savedFilters";
const NO_FLOWS: FlowSummary[] = [];
const FILTERS: SavedFilter[] = [
  {
    id: "f1",
    query: "host:api",
    kinds: [],
    statuses: [],
    color: "#e879f9",
    opacity: 16,
    highlight: true,
  },
  {
    id: "f2",
    query: "status:4xx",
    kinds: [],
    statuses: [],
    color: "#fbbf24",
    opacity: 24,
    highlight: true,
  },
];

function filterColor(
  filters: SavedFilter[],
  id: string,
): Pick<SavedFilter, "color" | "opacity"> | undefined {
  const filter = filters.find((f) => f.id === id);
  return filter ? { color: filter.color, opacity: filter.opacity } : undefined;
}

describe("useSavedFilters color preview lifecycle", () => {
  beforeEach(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(FILTERS));
  });

  afterEach(() => {
    localStorage.removeItem(FILTERS_KEY);
  });

  it("keeps one scoped preview and clears it when another operation takes over", async () => {
    const stored = localStorage.getItem(FILTERS_KEY);
    const hook = await renderHook(() => useSavedFilters(NO_FLOWS, null, vi.fn()));
    const baseTints = hook.result.current.tints;
    const basePresentations = hook.result.current.tintPresentations;

    hook.result.current.previewFilterColor("f1", { hex: "#112233", alphaPct: 40 });
    await vi.waitFor(() => {
      expect(filterColor(hook.result.current.filters, "f1")).toEqual({
        color: "#112233",
        opacity: 40,
      });
      expect(hook.result.current.tints).toBe(baseTints);
      expect(hook.result.current.tintPresentations).not.toBe(basePresentations);
      expect(hook.result.current.tintPresentations.get("f1")).toEqual({
        color: "#112233",
        opacity: 40,
        label: "host:api",
      });
    });

    hook.result.current.previewFilterColor("f2", { hex: "#445566", alphaPct: 55 });
    await vi.waitFor(() => {
      expect(filterColor(hook.result.current.filters, "f1")).toEqual({
        color: "#e879f9",
        opacity: 16,
      });
      expect(filterColor(hook.result.current.filters, "f2")).toEqual({
        color: "#445566",
        opacity: 55,
      });
    });

    // A late cancel from the replaced picker must not clear the active one.
    hook.result.current.cancelFilterColorPreview("f1");
    expect(filterColor(hook.result.current.filters, "f2")).toEqual({
      color: "#445566",
      opacity: 55,
    });
    await delay(350);
    expect(localStorage.getItem(FILTERS_KEY)).toBe(stored);

    // Any committed filter operation replaces the remaining draft preview.
    hook.result.current.updateFilter("f1", { query: "host:service" });
    await vi.waitFor(() => {
      expect(filterColor(hook.result.current.filters, "f2")).toEqual({
        color: "#fbbf24",
        opacity: 24,
      });
    });
  });

  it("drops the preview when its target filter disappears", async () => {
    const hook = await renderHook(() => useSavedFilters(NO_FLOWS, null, vi.fn()));
    hook.result.current.previewFilterColor("f1", { hex: "#112233", alphaPct: 40 });
    await vi.waitFor(() =>
      expect(filterColor(hook.result.current.filters, "f1")?.color).toBe("#112233"),
    );

    hook.result.current.removeFilter("f1");
    await vi.waitFor(() => {
      expect(hook.result.current.filters.map((f) => f.id)).toEqual(["f2"]);
      expect(filterColor(hook.result.current.filters, "f2")).toEqual({
        color: "#fbbf24",
        opacity: 24,
      });
    });
  });
});
