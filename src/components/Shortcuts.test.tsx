import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { RESOURCE_TYPE_META } from "../resourceType";
import { DEFAULT_SHORTCUTS } from "../shortcuts";
import { Shortcuts } from "./Shortcuts";

describe("Help resource icon legend", () => {
  it("lists every icon family without adding redundant keyboard stops", async () => {
    const onClose = vi.fn();
    const screen = await render(<Shortcuts bindings={DEFAULT_SHORTCUTS} onClose={onClose} />);
    const legend = screen.getByRole("region", { name: "Resource icons" }).element();
    const items = [...legend.querySelectorAll<HTMLElement>(".resource-legend-item")];

    await expect.element(screen.getByRole("dialog", { name: "Help" })).toBeVisible();
    expect(items).toHaveLength(RESOURCE_TYPE_META.length);
    expect(items.map((item) => item.querySelector(".resource-legend-label")?.textContent)).toEqual(
      RESOURCE_TYPE_META.map(({ label }) => label),
    );

    const jsIcon = legend.querySelector(".resource-icon-javascript") as SVGElement;
    expect(jsIcon.querySelector("text")?.textContent).toBe("JS");
    expect(jsIcon.getAttribute("aria-hidden")).toBe("true");
    expect(jsIcon.getAttribute("focusable")).toBe("false");
    expect(
      legend.querySelectorAll(
        '[role="img"], [tabindex], [title], .resource-icon-label, .tooltip-trigger',
      ),
    ).toHaveLength(0);

    await userEvent.hover(jsIcon);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "Help" }).element();
    const close = screen.getByRole("button", { name: "Close" }).element();
    const sequential = [
      ...dialog.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ].filter((element) => element.tabIndex >= 0);
    expect(sequential).toEqual([close]);

    close.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
    expect(legend.contains(document.activeElement)).toBe(false);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("packs independent shortcut columns and keeps the complete legend reachable", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(800, 1200);

    try {
      const screen = await render(<Shortcuts bindings={DEFAULT_SHORTCUTS} onClose={vi.fn()} />);
      const dialog = screen.getByRole("dialog", { name: "Help" }).element() as HTMLDialogElement;
      const legend = screen.getByRole("region", { name: "Resource icons" }).element();
      const globalGroup = screen
        .getByRole("heading", { name: "Global" })
        .element()
        .closest(".shortcuts-group") as HTMLElement;
      const panelsGroup = screen
        .getByRole("heading", { name: "Panels" })
        .element()
        .closest(".shortcuts-group") as HTMLElement;
      const trafficGroup = screen
        .getByRole("heading", { name: "Traffic" })
        .element()
        .closest(".shortcuts-group") as HTMLElement;

      const globalBox = globalGroup.getBoundingClientRect();
      const panelsBox = panelsGroup.getBoundingClientRect();
      const trafficBox = trafficGroup.getBoundingClientRect();
      const legendBox = legend.getBoundingClientRect();
      const dialogBox = dialog.getBoundingClientRect();

      expect(Math.abs(globalBox.left - panelsBox.left)).toBeLessThan(1);
      expect(trafficBox.left).toBeGreaterThan(globalBox.right);
      expect(panelsBox.top).toBeGreaterThanOrEqual(globalBox.bottom);
      expect(panelsBox.top).toBeLessThan(trafficBox.bottom);
      expect(legendBox.top).toBeGreaterThanOrEqual(trafficBox.bottom);
      expect(legendBox.top - trafficBox.bottom).toBeLessThan(40);
      expect(legendBox.bottom).toBeLessThanOrEqual(dialogBox.bottom);

      await page.viewport(800, 500);
      await vi.waitFor(() => expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight));
      legend.scrollIntoView({ block: "end" });
      await vi.waitFor(() => {
        const narrowDialogBox = dialog.getBoundingClientRect();
        const narrowLegendBox = legend.getBoundingClientRect();
        expect(narrowLegendBox.top).toBeGreaterThanOrEqual(narrowDialogBox.top);
        expect(narrowLegendBox.bottom).toBeLessThanOrEqual(narrowDialogBox.bottom);
      });
      expect(
        [...legend.querySelectorAll<HTMLElement>(".resource-legend-item")].every((item) => {
          const itemBox = item.getBoundingClientRect();
          const narrowDialogBox = dialog.getBoundingClientRect();
          return itemBox.top >= narrowDialogBox.top && itemBox.bottom <= narrowDialogBox.bottom;
        }),
      ).toBe(true);

      await page.viewport(390, 800);
      dialog.scrollTop = 0;
      await vi.waitFor(() => {
        const leftColumn = globalGroup.closest(".shortcuts-column") as HTMLElement;
        const rightColumn = trafficGroup.closest(".shortcuts-column") as HTMLElement;
        expect(rightColumn.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          leftColumn.getBoundingClientRect().bottom,
        );
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      });
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
});
