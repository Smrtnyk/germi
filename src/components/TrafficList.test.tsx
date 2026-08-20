import { type ComponentProps, type CSSProperties } from "react";
import { delay } from "es-toolkit";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { resolvePresentedTint, type SavedFilter } from "../savedFilters";
import { useSavedFilters } from "../useSavedFilters";
import { FilterChips } from "./FilterChips";
import { FiltersPanel } from "./FiltersPanel";
import { CommentCell, FlowRow, HeaderRow, TrafficList } from "./TrafficList";
import { resolveColumns } from "../columns";
import type { FlowSummary } from "../types";

afterEach(() => {
  localStorage.removeItem("germi.colWidths");
});

function flowSummary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
    seq: 1,
    method: "GET",
    host: "example.com",
    path: "/",
    scheme: "https",
    status: 200,
    mime: null,
    kind: "doc",
    reqSize: 0,
    respSize: 0,
    durationMs: null,
    ttfbMs: null,
    matchedRule: null,
    timestampMs: 0,
    comment: null,
    availability: null,
    imported: false,
    extra: {},
    ...overrides,
  };
}

const SAVED_FILTERS_KEY = "germi.savedFilters";
const PREVIEW_FILTER: SavedFilter = {
  id: "f1",
  query: "host:example.com",
  kinds: [],
  statuses: [],
  color: "#e879f9",
  opacity: 16,
  highlight: true,
};
const PREVIEW_FLOW = flowSummary({ imported: true });
const PREVIEW_FLOWS = [PREVIEW_FLOW];

function editingComments(overrides: Partial<ReturnType<typeof commentDraft>> = {}) {
  return { ...commentDraft(), ...overrides };
}

function commentDraft() {
  return {
    editingId: "1" as string | null,
    draft: "",
    cancelEdit: { current: false } as { current: boolean },
    setDraft: vi.fn(),
    setEditingId: vi.fn(),
    beginEdit: vi.fn(),
    commitComment: vi.fn(),
  };
}

function SavedFilterColorHarness({
  selection = "none",
}: {
  selection?: "none" | "selected" | "checked";
}) {
  const savedFilters = useSavedFilters(PREVIEW_FLOWS, null, vi.fn());
  return (
    <>
      <FiltersPanel
        filters={savedFilters.filters}
        soloId={savedFilters.soloId}
        counts={savedFilters.counts}
        canSaveCurrent={false}
        onSaveCurrent={vi.fn()}
        onColorPreview={savedFilters.previewFilterColor}
        onColorPreviewCancel={savedFilters.cancelFilterColorPreview}
        onUpdate={savedFilters.updateFilter}
        onRemove={savedFilters.removeFilter}
        onSolo={savedFilters.setSolo}
      />
      <FilterChips
        typeChips={new Set()}
        statusChips={new Set()}
        onToggleType={vi.fn()}
        onToggleStatus={vi.fn()}
        onClearAll={vi.fn()}
        filter=""
        onFilterChange={vi.fn()}
        searching={false}
        matchCount={null}
        total={PREVIEW_FLOWS.length}
        view={{
          mode: savedFilters.viewMode,
          onMode: savedFilters.setViewMode,
          accel: "Ctrl+Shift+H",
          barActive: false,
          onSave: vi.fn(),
          solo: savedFilters.soloChip,
          onClearSolo: savedFilters.clearSolo,
        }}
        onCheckAvailability={vi.fn()}
        availabilityCheck={null}
        capturedDelete={{ capturedCount: 0, importedCount: 0, onDelete: vi.fn() }}
      />
      <div className="flow-list" style={{ "--cols": "320px" } as CSSProperties}>
        <div className="flow-canvas">
          <FlowRow
            f={PREVIEW_FLOW}
            item={{ start: 0, size: 26 }}
            columns={resolveColumns(["url"], [])}
            selected={selection === "selected"}
            inSet={selection === "checked"}
            matched={false}
            dimmed={false}
            tint={resolvePresentedTint(
              PREVIEW_FLOW.id,
              savedFilters.tints,
              savedFilters.tintPresentations,
            )}
            comments={editingComments({ editingId: null })}
            onRowClick={vi.fn()}
            onActivate={vi.fn()}
            onOpenMenu={vi.fn()}
            onDragStart={vi.fn()}
          />
        </div>
      </div>
    </>
  );
}

function renderedPreviewRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>(".flow-canvas .flow-row");
  if (!row) throw new Error("Preview flow row is missing");
  return row;
}

describe("CommentCell", () => {
  const spies: (() => void)[] = [];
  afterEach(() => {
    for (const off of spies.splice(0)) off();
  });

  function watchWindowKeydown() {
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    spies.push(() => window.removeEventListener("keydown", spy));
    return spy;
  }

  it("lets Ctrl+F bubble to the window keydown handler while editing", async () => {
    const onWindowKey = watchWindowKeydown();
    const screen = await render(<CommentCell f={flowSummary()} comments={editingComments()} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Control>}f{/Control}");

    const events = onWindowKey.mock.calls.map(([e]) => e as KeyboardEvent);
    expect(events.some((e) => e.ctrlKey && e.key.toLowerCase() === "f")).toBe(true);
  });

  it("commits the comment on Enter", async () => {
    const comments = editingComments();
    const screen = await render(<CommentCell f={flowSummary()} comments={comments} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Enter}");

    expect(comments.commitComment).toHaveBeenCalledWith("1");
    expect(comments.cancelEdit.current).toBe(true);
  });

  it("cancels the edit on Escape without committing", async () => {
    const comments = editingComments();
    const screen = await render(<CommentCell f={flowSummary()} comments={comments} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Escape}");

    expect(comments.setEditingId).toHaveBeenCalledWith(null);
    expect(comments.commitComment).not.toHaveBeenCalled();
    expect(comments.cancelEdit.current).toBe(true);
  });
});

describe("FlowRow saved-filter tint", () => {
  beforeEach(() => {
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify([PREVIEW_FILTER]));
  });

  afterEach(() => {
    localStorage.removeItem(SAVED_FILTERS_KEY);
  });

  function renderRow(over: Partial<ComponentProps<typeof FlowRow>> = {}) {
    return render(
      <div className="flow-list" style={{ "--cols": "320px" } as CSSProperties}>
        <div className="flow-canvas">
          <FlowRow
            f={flowSummary()}
            item={{ start: 0, size: 26 }}
            columns={resolveColumns(["url"], [])}
            selected={false}
            inSet={false}
            matched={false}
            dimmed={false}
            tint={{ filterId: "f1", color: "#ff0000", opacity: 16, label: "api errors" }}
            comments={editingComments({ editingId: null })}
            onRowClick={vi.fn()}
            onActivate={vi.fn()}
            onOpenMenu={vi.fn()}
            onDragStart={vi.fn()}
            {...over}
          />
        </div>
      </div>,
    );
  }

  it("tints the row with the filter color and names it in the tooltip", async () => {
    const screen = await renderRow();
    const row = screen.getByTitle("saved filter: api errors").element() as HTMLElement;
    expect(row.classList.contains("tinted")).toBe(true);
    expect(row.style.getPropertyValue("--row-tint")).toBe("#ff0000");
    expect(getComputedStyle(row).backgroundColor).toBe("color(srgb 1 0 0 / 0.16)");
  });

  it("live-previews hue and opacity across the row, picker, and solo indicator", async () => {
    const stored = localStorage.getItem(SAVED_FILTERS_KEY);
    const screen = await render(<SavedFilterColorHarness />);
    await screen.getByRole("button", { name: "only" }).click();
    const row = renderedPreviewRow();
    expect(row.title).toContain("saved filter: host:example.com");
    const swatch = document.querySelector<HTMLElement>(".filters-panel .color-picker-swatch-tint")!;
    const solo = document.querySelector<HTMLElement>(".solo-dot .saved-filter-preview-tint")!;
    const prior = {
      row: getComputedStyle(row).backgroundColor,
      swatch: getComputedStyle(swatch).backgroundColor,
      solo: getComputedStyle(solo).backgroundColor,
    };

    await screen.getByRole("button", { name: "Saved filter host:example.com color" }).click();
    await screen.getByLabelText("Hex").fill("#00ff00");
    expect(getComputedStyle(row).backgroundColor).toBe("color(srgb 0 1 0 / 0.16)");

    await screen.getByRole("slider", { name: "Saved filter host:example.com opacity" }).fill("40");
    const preview = document.querySelector<HTMLElement>(".color-picker-dialog-preview > span")!;
    const applied = getComputedStyle(row).backgroundColor;
    expect(applied).toBe("color(srgb 0 1 0 / 0.4)");
    for (const surface of [swatch, solo]) {
      expect(getComputedStyle(surface).backgroundColor).toBe(applied);
    }
    expect(getComputedStyle(preview).backgroundColor).toBe("rgba(0, 255, 0, 0.4)");
    await delay(350);
    expect(localStorage.getItem(SAVED_FILTERS_KEY)).toBe(stored);

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(getComputedStyle(row).backgroundColor).toBe(prior.row);
    expect(getComputedStyle(swatch).backgroundColor).toBe(prior.swatch);
    expect(getComputedStyle(solo).backgroundColor).toBe(prior.solo);
    expect(localStorage.getItem(SAVED_FILTERS_KEY)).toBe(stored);
  });

  it("restores the exact prior tint on Escape without persisting", async () => {
    const stored = localStorage.getItem(SAVED_FILTERS_KEY);
    const screen = await render(<SavedFilterColorHarness />);
    const trigger = screen.getByRole("button", {
      name: "Saved filter host:example.com color",
    });
    const row = renderedPreviewRow();
    const prior = getComputedStyle(row).backgroundColor;

    await trigger.click();
    await screen.getByLabelText("Hex").fill("#00ff0080");
    expect(getComputedStyle(row).backgroundColor).toBe("color(srgb 0 1 0 / 0.5)");
    await userEvent.keyboard("{Escape}");

    expect(getComputedStyle(row).backgroundColor).toBe(prior);
    expect(localStorage.getItem(SAVED_FILTERS_KEY)).toBe(stored);
    expect(document.activeElement).toBe(trigger.element());
  });

  it("keeps an applied combined tint and persists it after the debounce", async () => {
    const screen = await render(<SavedFilterColorHarness />);
    await screen.getByRole("button", { name: "Saved filter host:example.com color" }).click();
    await screen.getByLabelText("Hex").fill("#00ff00");
    await screen.getByRole("slider", { name: "Saved filter host:example.com opacity" }).fill("40");
    await screen.getByRole("button", { name: "Apply" }).click();

    const row = renderedPreviewRow();
    expect(getComputedStyle(row).backgroundColor).toBe("color(srgb 0 1 0 / 0.4)");
    await vi.waitFor(() => {
      const [persisted] = JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY) ?? "[]");
      expect(persisted).toMatchObject({ color: "#00ff00", opacity: 40 });
    });
  });

  it("keeps selected/checked precedence and provenance shadows during preview", async () => {
    const screen = await render(<SavedFilterColorHarness selection="selected" />);
    await screen.getByRole("button", { name: "Saved filter host:example.com color" }).click();
    await screen.getByLabelText("Hex").fill("#00ff0080");

    const selected = renderedPreviewRow();
    expect(getComputedStyle(selected).backgroundColor).toBe("rgb(23, 58, 54)");
    expect(getComputedStyle(selected).boxShadow).not.toBe("none");
    expect(selected.style.getPropertyValue("--row-tint")).toBe("");

    await screen.rerender(<SavedFilterColorHarness selection="checked" />);
    const checked = renderedPreviewRow();
    expect(getComputedStyle(checked).backgroundColor).toBe("rgba(96, 165, 250, 0.13)");
    expect(getComputedStyle(checked).boxShadow).not.toBe("none");
    expect(checked.style.getPropertyValue("--row-tint")).toBe("");
  });

  it("yields the tint to a selected row but keeps the tooltip", async () => {
    const screen = await renderRow({ selected: true });
    const row = screen.getByTitle("saved filter: api errors").element() as HTMLElement;
    expect(row.classList.contains("tinted")).toBe(false);
    expect(row.style.getPropertyValue("--row-tint")).toBe("");
    expect(getComputedStyle(row).backgroundColor).toBe("rgb(23, 58, 54)");
  });

  it("yields the tint to a multi-selected row", async () => {
    const screen = await renderRow({ inSet: true });
    const row = screen.getByTitle("saved filter: api errors").element() as HTMLElement;
    expect(row.classList.contains("tinted")).toBe(false);
    expect(row.style.getPropertyValue("--row-tint")).toBe("");
    expect(getComputedStyle(row).backgroundColor).toBe("rgba(96, 165, 250, 0.13)");
  });
});

describe("FlowRow resource icon", () => {
  function renderRow(flow: FlowSummary, over: Partial<ComponentProps<typeof FlowRow>> = {}) {
    return render(
      <div className="flow-list" style={{ "--cols": "60px 62px" } as CSSProperties}>
        <div className="flow-canvas" style={{ height: 26 }}>
          <FlowRow
            f={flow}
            item={{ start: 0, size: 26 }}
            columns={resolveColumns(["seq", "method"], [])}
            selected={false}
            inSet={false}
            matched={false}
            dimmed={false}
            tint={undefined}
            comments={editingComments({ editingId: null })}
            onRowClick={vi.fn()}
            onActivate={vi.fn()}
            onOpenMenu={vi.fn()}
            onDragStart={vi.fn()}
            {...over}
          />
        </div>
      </div>,
    );
  }

  it("renders a decorative colored SVG inside the request-number cell", async () => {
    const screen = await renderRow(flowSummary({ mime: "application/json" }));
    const number = screen.getByText("1").element();
    const cell = number.closest(".c-seq-cell") as HTMLElement;
    const icon = cell.querySelector("svg") as SVGElement;
    const cellBox = cell.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const numberBox = number.getBoundingClientRect();

    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(icon.querySelectorAll("path").length).toBe(2);
    expect(icon.classList.contains("resource-icon-json")).toBe(true);
    expect(getComputedStyle(icon).color).toBe("rgb(147, 51, 234)");
    expect(icon.closest("[role=img]")?.getAttribute("aria-label")).toBe("JSON resource");
    expect(icon.closest("[role=img]")?.getAttribute("title")).toBe("JSON resource");
    expect(icon.closest("[role=img]")?.hasAttribute("tabindex")).toBe(false);
    expect(cell.querySelector(".tooltip-trigger, .tooltip-popup")).toBeNull();
    expect(iconBox.left).toBeGreaterThanOrEqual(cellBox.left);
    expect(iconBox.right).toBeLessThan(numberBox.left);
    expect(Math.abs(numberBox.right - cellBox.right)).toBeLessThan(0.5);
  });

  it("shows JS text and keeps recorded/imported icon tooltips separate from provenance", async () => {
    const flows = [
      flowSummary({
        id: "imported",
        seq: 1,
        mime: "text/javascript",
        kind: "js",
        imported: true,
      }),
      flowSummary({
        id: "recorded",
        seq: 2,
        mime: "text/javascript",
        kind: "js",
      }),
    ];
    const screen = await render(
      <div className="flow-list" style={{ "--cols": "60px 62px" } as CSSProperties}>
        <div className="flow-canvas" style={{ height: 52 }}>
          {flows.map((flow, index) => (
            <FlowRow
              key={flow.id}
              f={flow}
              item={{ start: index * 26, size: 26 }}
              columns={resolveColumns(["seq", "method"], [])}
              selected={false}
              inSet={false}
              matched={false}
              dimmed={false}
              tint={undefined}
              comments={editingComments({ editingId: null })}
              onRowClick={vi.fn()}
              onActivate={vi.fn()}
              onOpenMenu={vi.fn()}
              onDragStart={vi.fn()}
            />
          ))}
        </div>
      </div>,
    );
    const importedRow = screen.getByText("1").element().closest(".flow-row") as HTMLElement;
    const recordedRow = screen.getByText("2").element().closest(".flow-row") as HTMLElement;
    const importedTrigger = importedRow.querySelector('[role="img"]') as HTMLElement;
    const recordedTrigger = recordedRow.querySelector('[role="img"]') as HTMLElement;

    expect(importedRow.title).toBe("imported from file");
    expect(recordedRow.hasAttribute("title")).toBe(false);
    expect(importedTrigger.title).toBe("JavaScript resource");
    expect(recordedTrigger.title).toBe("JavaScript resource");
    expect(importedTrigger.hasAttribute("tabindex")).toBe(false);
    expect(recordedTrigger.hasAttribute("tabindex")).toBe(false);
    expect(importedTrigger.querySelector("text")?.textContent).toBe("JS");
    for (const trigger of [importedTrigger, recordedTrigger]) {
      expect(trigger.classList.contains("resource-icon-label")).toBe(true);
      expect(trigger.matches(".tooltip-trigger, .tooltip-popup")).toBe(false);
      expect(trigger.querySelector(".tooltip-trigger, .tooltip-popup")).toBeNull();
      const triggerBox = trigger.getBoundingClientRect();
      const slotBox = (
        trigger.closest(".c-resource-icon-slot") as HTMLElement
      ).getBoundingClientRect();
      expect(Math.abs(triggerBox.width - slotBox.width)).toBeLessThan(0.5);
      expect(Math.abs(triggerBox.height - slotBox.height)).toBeLessThan(0.5);
    }

    await userEvent.hover(importedTrigger);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
    expect(importedTrigger.title).not.toContain("imported");
    await userEvent.unhover(importedTrigger);

    await userEvent.hover(recordedTrigger);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
  });

  it("omits the SVG for an unknown type without moving the request number", async () => {
    const screen = await renderRow(flowSummary({ mime: "application/x-private", kind: "other" }));
    const number = screen.getByText("1").element();
    const cell = number.closest(".c-seq-cell") as HTMLElement;
    const slot = cell.querySelector(".c-resource-icon-slot") as HTMLElement;

    expect(cell.querySelector("svg")).toBeNull();
    expect(slot.getBoundingClientRect().width).toBe(14);
    expect(
      Math.abs(number.getBoundingClientRect().right - cell.getBoundingClientRect().right),
    ).toBe(0);
  });

  it("keeps selection and click handling on a row when the icon is clicked", async () => {
    const onRowClick = vi.fn();
    const screen = await renderRow(flowSummary({ mime: "text/css" }), {
      selected: true,
      onRowClick,
    });
    const row = screen.getByText("1").element().closest(".flow-row") as HTMLElement;
    const icon = row.querySelector("svg") as SVGElement;

    await userEvent.click(icon);

    expect(row.classList.contains("selected")).toBe(true);
    expect(getComputedStyle(row).backgroundColor).toBe("rgb(23, 58, 54)");
    expect(onRowClick.mock.calls[0]?.[0]).toBe("1");
  });
});

describe("TrafficList empty states", () => {
  function listProps(over: Partial<ComponentProps<typeof TrafficList>> = {}) {
    return {
      flows: [],
      view: {
        matchedIds: null,
        savedTints: new Map(),
        savedTintPresentations: new Map(),
        totalCount: 0,
      },
      columns: resolveColumns(["url"], []),
      sort: null,
      onToggleSort: vi.fn(),
      selectedId: null,
      selectedIds: new Set<string>(),
      onRowClick: vi.fn(),
      onKeySelect: vi.fn(),
      onClearSelection: vi.fn(),
      onDeleteSelected: vi.fn(),
      onCommentEdit: vi.fn(),
      onMockFlow: vi.fn(),
      onFilterToHost: vi.fn(),
      onExcludeHost: vi.fn(),
      onCopyCurl: vi.fn(),
      onCopyBody: vi.fn(),
      onCompareSelected: vi.fn(),
      viewer: false,
      ...over,
    };
  }

  it("explains that rows are hidden by the filter when flows exist", async () => {
    const view = {
      matchedIds: null,
      savedTints: new Map(),
      savedTintPresentations: new Map(),
      totalCount: 4,
    };
    const screen = await render(<TrafficList {...listProps({ view })} />);
    await expect
      .element(screen.getByText(/All 4 requests are hidden by the active filter/))
      .toBeVisible();
  });

  it("keeps the no-traffic onboarding hint when nothing was captured", async () => {
    const screen = await render(<TrafficList {...listProps()} />);
    await expect.element(screen.getByText(/No traffic yet/)).toBeVisible();
  });

  it("keeps arrow-key selection working with resource icons present", async () => {
    const onKeySelect = vi.fn();
    const screen = await render(
      <>
        <div style={{ display: "grid", height: 180, width: 640 }}>
          <TrafficList
            {...listProps({
              flows: [
                flowSummary({ id: "one", seq: 1, method: "GET", mime: "text/html" }),
                flowSummary({ id: "two", seq: 2, method: "POST", mime: "application/json" }),
              ],
              view: { matchedIds: null, savedTints: new Map(), totalCount: 2 },
              columns: resolveColumns(["seq", "method"], []),
              onKeySelect,
            })}
          />
        </div>
        <button>After list</button>
      </>,
    );
    const scroll = screen.getByText("GET").element().closest(".flow-scroll") as HTMLElement;
    scroll.focus();

    await userEvent.keyboard("{ArrowDown}");

    expect(onKeySelect).toHaveBeenCalledWith("one", false);
    expect(document.activeElement).toBe(scroll);

    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "After list" }).element(),
    );
  });

  it("keeps sequence order, sorting, persisted width, and the 26px virtual row height", async () => {
    localStorage.setItem("germi.colWidths", JSON.stringify({ seq: 72 }));
    const onToggleSort = vi.fn();
    const screen = await render(
      <div style={{ display: "grid", height: 180, width: 640 }}>
        <TrafficList
          {...listProps({
            flows: [flowSummary({ seq: 9, method: "POST", mime: "text/css" })],
            view: { matchedIds: null, savedTints: new Map(), totalCount: 1 },
            columns: resolveColumns(["method", "seq"], []),
            onToggleSort,
          })}
        />
      </div>,
    );
    const number = screen.getByText("9").element();
    const row = number.closest(".flow-row") as HTMLElement;
    const header = screen
      .getByRole("button", { name: "Method" })
      .element()
      .closest(".flow-head") as HTMLElement;
    const seqHeader = header.children[1] as HTMLElement;

    expect(header.children[0].textContent).toContain("Method");
    expect(seqHeader.textContent).toContain("#");
    expect(row.children[0].textContent).toBe("POST");
    expect(row.children[1].textContent).toBe("9");
    expect(row.getBoundingClientRect().height).toBe(26);
    expect(row.children[1].getBoundingClientRect().width).toBe(72);

    await screen.getByRole("button", { name: "#" }).click();
    expect(onToggleSort).toHaveBeenCalledWith("seq");

    await userEvent.dblClick(seqHeader.querySelector(".col-resize") as HTMLElement);
    expect(row.children[1].getBoundingClientRect().width).toBe(60);
  });
});

describe("HeaderRow sort target", () => {
  function renderHeader(onToggleSort = vi.fn()) {
    const [col] = resolveColumns(["url"], []);
    return render(
      <div className="flow-list" style={{ "--cols": "320px", "--row-w": "360px" } as CSSProperties}>
        <HeaderRow
          columns={[col]}
          headerRef={{ current: null }}
          sort={null}
          onToggleSort={onToggleSort}
          startResize={vi.fn()}
          resetWidth={vi.fn()}
        />
      </div>,
    );
  }

  it("stretches the sort button to fill the whole header cell", async () => {
    const screen = await renderHeader();
    const button = screen.getByRole("button", { name: /url/i });
    const btnEl = button.element();
    const cellEl = btnEl.parentElement as HTMLElement;

    const b = btnEl.getBoundingClientRect();
    const c = cellEl.getBoundingClientRect();

    expect(c.width).toBeGreaterThan(100);
    expect(Math.abs(b.width - c.width)).toBeLessThan(2);
    expect(Math.abs(b.height - c.height)).toBeLessThan(2);
  });

  it("sorts when clicking the empty column area, not just the label text", async () => {
    const onToggleSort = vi.fn();
    const screen = await renderHeader(onToggleSort);
    const cellEl = screen.getByRole("button", { name: /url/i }).element()
      .parentElement as HTMLElement;
    const c = cellEl.getBoundingClientRect();

    await userEvent.click(cellEl, { position: { x: c.width - 20, y: c.height / 2 } });

    expect(onToggleSort).toHaveBeenCalledWith("url");
  });
});
