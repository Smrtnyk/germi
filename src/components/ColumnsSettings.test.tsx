import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import type { ProxySettings } from "../types";
import { DEFAULT_FILTER_COLOR_PRESETS } from "../filterColorPresets";
import { ColumnsSettings } from "./ColumnsSettings";

function settings(): ProxySettings {
  return {
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    theme: "dark",
    highlightColors: {},
    filterColorPresets: [...DEFAULT_FILTER_COLOR_PRESETS],
  };
}

function Harness({
  initial,
  onOrderChange,
  onSettingsChange,
}: {
  initial: string[];
  onOrderChange: (order: string[]) => void;
  onSettingsChange: (settings: ProxySettings) => void;
}) {
  const [order, setOrder] = useState(initial);
  return (
    <ColumnsSettings
      order={order}
      onOrderChange={(next) => {
        onOrderChange(next);
        setOrder(next);
      }}
      settings={settings()}
      onSettingsChange={onSettingsChange}
    />
  );
}

function shownList(): HTMLUListElement {
  const list = document.querySelector<HTMLUListElement>('ul[aria-label="Shown columns"]');
  if (!list) throw new Error("Shown columns list is missing");
  return list;
}

function shownRows(): HTMLLIElement[] {
  return [...shownList().querySelectorAll<HTMLLIElement>(":scope > li")];
}

function row(label: string): HTMLLIElement {
  const match = shownRows().find(
    (item) => item.querySelector(".col-name")?.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Column row is missing: ${label}`);
  return match;
}

function labels(): string[] {
  return shownRows().map((item) => item.querySelector(".col-name")?.textContent?.trim() ?? "");
}

function dragEvent(target: EventTarget, type: string, dataTransfer: DataTransfer, clientY = 0) {
  target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientY }),
  );
}

async function startDrag(source: HTMLLIElement) {
  const handle = source.querySelector<HTMLElement>(".col-drag-handle");
  if (!handle) throw new Error("Column drag handle is missing");
  const dataTransfer = new DataTransfer();
  dragEvent(handle, "dragstart", dataTransfer);
  await vi.waitFor(() => expect(source.classList.contains("dragging")).toBe(true));
  return { dataTransfer, handle };
}

function edgeY(target: HTMLLIElement, edge: "before" | "after"): number {
  const rect = target.getBoundingClientRect();
  return edge === "before" ? rect.top + 1 : rect.bottom - 1;
}

async function dropColumn(source: HTMLLIElement, target: HTMLLIElement, edge: "before" | "after") {
  const { dataTransfer, handle } = await startDrag(source);
  const clientY = edgeY(target, edge);
  dragEvent(target, "dragenter", dataTransfer, clientY);
  dragEvent(target, "dragover", dataTransfer, clientY);
  dragEvent(target, "drop", dataTransfer, clientY);
  dragEvent(handle, "dragend", dataTransfer, clientY);
}

describe("ColumnsSettings", () => {
  it("describes pointer reordering and limits draggable behavior to visible grip handles", async () => {
    const screen = await render(
      <Harness
        initial={["seq", "method", "url"]}
        onOrderChange={vi.fn()}
        onSettingsChange={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: "Shown columns" });
    const descriptionId = list.element().getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "Drag a shown column by its handle, or use its arrow buttons.",
    );
    for (const item of shownRows()) {
      expect(item.draggable).toBe(false);
      const handle = item.querySelector<HTMLElement>(".col-drag-handle");
      expect(handle?.draggable).toBe(true);
      expect(handle?.getAttribute("aria-hidden")).toBe("true");
    }
    await expect.element(screen.getByRole("button", { name: "Move Method down" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Hide Method" })).toBeVisible();
  });

  it("keeps arrow reordering keyboard-accessible, focused and stable around stale ids", async () => {
    const onOrderChange = vi.fn();
    const screen = await render(
      <Harness
        initial={["seq", "stale-column", "method", "host", "url"]}
        onOrderChange={onOrderChange}
        onSettingsChange={vi.fn()}
      />,
    );

    const moveDown = screen.getByRole("button", { name: "Move Method down" });
    await moveDown.click();
    expect(onOrderChange).toHaveBeenLastCalledWith([
      "seq",
      "stale-column",
      "host",
      "method",
      "url",
    ]);
    await expect.element(moveDown).toHaveFocus();
    expect(labels()).toEqual(["#", "Host", "Method", "URL"]);
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Method moved to position 3 of 4.");

    const moveUp = screen.getByRole("button", { name: "Move Method up" });
    await moveUp.click();
    expect(onOrderChange).toHaveBeenLastCalledWith([
      "seq",
      "stale-column",
      "method",
      "host",
      "url",
    ]);
    await expect.element(moveUp).toHaveFocus();
    expect(labels()).toEqual(["#", "Method", "Host", "URL"]);
  });

  it("drags across multiple positions in either direction without disturbing stale ids", async () => {
    const onOrderChange = vi.fn();
    const onSettingsChange = vi.fn();
    const screen = await render(
      <Harness
        initial={["seq", "stale-column", "method", "host", "path", "url"]}
        onOrderChange={onOrderChange}
        onSettingsChange={onSettingsChange}
      />,
    );

    await dropColumn(row("Method"), row("Path"), "after");
    await vi.waitFor(() => expect(labels()).toEqual(["#", "Host", "Path", "Method", "URL"]));
    expect(onOrderChange).toHaveBeenLastCalledWith([
      "seq",
      "stale-column",
      "host",
      "path",
      "method",
      "url",
    ]);

    await dropColumn(row("URL"), row("#"), "before");
    await vi.waitFor(() => expect(labels()).toEqual(["URL", "#", "Host", "Path", "Method"]));
    expect(onOrderChange).toHaveBeenLastCalledWith([
      "url",
      "stale-column",
      "seq",
      "host",
      "path",
      "method",
    ]);
    expect(onOrderChange).toHaveBeenCalledTimes(2);
    expect(onSettingsChange).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("URL moved to position 1 of 5.");
  });

  it("does not reorder or announce same-row, current-boundary, canceled or outside drops", async () => {
    const onOrderChange = vi.fn();
    const onSettingsChange = vi.fn();
    const screen = await render(
      <Harness
        initial={["seq", "method", "host", "path"]}
        onOrderChange={onOrderChange}
        onSettingsChange={onSettingsChange}
      />,
    );

    await dropColumn(row("Method"), row("Method"), "after");
    await dropColumn(row("Method"), row("#"), "after");
    await dropColumn(row("Method"), row("Host"), "before");

    const source = row("Method");
    const target = row("Path");
    const { dataTransfer, handle } = await startDrag(source);
    const clientY = edgeY(target, "after");
    dragEvent(target, "dragenter", dataTransfer, clientY);
    const child = target.querySelector<HTMLElement>(".col-name")!;
    dragEvent(child, "dragenter", dataTransfer, clientY);
    dragEvent(target, "dragover", dataTransfer, clientY);
    await vi.waitFor(() => expect(target.classList.contains("drop-after")).toBe(true));
    dragEvent(child, "dragleave", dataTransfer, clientY);
    expect(target.classList.contains("drop-after")).toBe(true);
    dragEvent(document.body, "drop", dataTransfer, clientY);
    dragEvent(handle, "dragend", dataTransfer, clientY);

    await vi.waitFor(() => expect(document.querySelector(".dragging, .drop-after")).toBeNull());
    expect(onOrderChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(labels()).toEqual(["#", "Method", "Host", "Path"]);
    expect(screen.getByRole("status").element().textContent).toBe("");
  });
});
