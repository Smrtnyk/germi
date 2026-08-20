import { createRef } from "react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { detail, message, summary } from "../flowFixtures";
import type { InspectorFindHandle } from "../inspectorFind";
import type { FlowDetail, FlowSummary } from "../types";
import { FlowInspector } from "./FlowInspector";

function inspectorDetail(id: string, path: string): FlowDetail {
  return detail({
    id,
    host: "assets.example.com",
    path,
    uri: `https://assets.example.com${path}`,
    response: message(),
  });
}

function InspectorHarness({
  flowDetail,
  flowSummary,
  width = 360,
  viewer = true,
}: {
  flowDetail: FlowDetail;
  flowSummary?: FlowSummary;
  width?: number;
  viewer?: boolean;
}) {
  return (
    <div className="right-content" style={{ width, height: 420 }}>
      <div className="pane">
        <FlowInspector
          active
          detail={flowDetail}
          summary={flowSummary}
          loading={false}
          decode
          onMock={vi.fn()}
          onCopyCurl={vi.fn()}
          onLoadFull={vi.fn()}
          selectedSummaries={flowSummary ? [flowSummary] : []}
          onSelectOne={vi.fn()}
          onMockMany={vi.fn()}
          onCompare={vi.fn()}
          onClearSelection={vi.fn()}
          inspectorFindRef={createRef<InspectorFindHandle>()}
          viewer={viewer}
        />
      </div>
    </div>
  );
}

describe("FlowInspector resource icon", () => {
  it("shows the selected resource type larger than the list icon without crowding a narrow header", async () => {
    const flowSummary = summary({ id: "json", mime: "application/json", kind: "xhr" });
    const screen = await render(
      <InspectorHarness
        flowDetail={inspectorDetail("json", "/api/orders")}
        flowSummary={flowSummary}
        width={300}
      />,
    );
    const trigger = screen.getByRole("img", { name: "JSON resource" }).element();
    const icon = trigger.querySelector("svg") as SVGElement;
    const header = trigger.closest(".req-head") as HTMLElement;
    const content = header.querySelector(".req-head-content") as HTMLElement;
    const iconBox = icon.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();

    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(trigger.hasAttribute("tabindex")).toBe(false);
    expect(trigger.getAttribute("title")).toBe("JSON resource");
    expect(trigger.classList.contains("resource-icon-label")).toBe(true);
    expect(header.querySelector(".tooltip-trigger, .tooltip-popup")).toBeNull();
    expect(iconBox.width).toBe(36);
    expect(iconBox.height).toBe(36);
    expect(iconBox.width).toBeGreaterThan(16);
    expect(iconBox.left).toBeGreaterThanOrEqual(headerBox.left);
    expect(contentBox.right).toBeLessThanOrEqual(headerBox.right);
    await expect.element(screen.getByText("GET")).toBeVisible();
    await expect.element(screen.getByText("200")).toBeVisible();
    await expect.element(screen.getByText("https://assets.example.com/api/orders")).toBeVisible();
    await expect.element(screen.getByTitle("Copy URL")).toBeVisible();
    await expect.element(screen.getByTitle("Copy as cURL")).toBeVisible();

    await userEvent.hover(trigger);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
  });

  it("removes a stale icon during selection changes, then shows the new selected type", async () => {
    const jsonSummary = summary({ id: "json", mime: "application/json", kind: "xhr" });
    const fontSummary = summary({ id: "font", mime: "font/woff2", kind: "font" });
    const jsonDetail = inspectorDetail("json", "/api/orders");
    const fontDetail = inspectorDetail("font", "/fonts/body.woff2");
    const screen = await render(
      <InspectorHarness flowDetail={jsonDetail} flowSummary={jsonSummary} />,
    );
    await expect.element(screen.getByRole("img", { name: "JSON resource" })).toBeVisible();

    await screen.rerender(<InspectorHarness flowDetail={jsonDetail} flowSummary={fontSummary} />);
    expect(document.querySelector(".inspector-resource-icon")).toBeNull();

    await screen.rerender(<InspectorHarness flowDetail={fontDetail} flowSummary={fontSummary} />);
    const fontIcon = screen.getByRole("img", { name: "Font resource" });
    await expect.element(fontIcon).toBeVisible();
    await expect
      .element(screen.getByText("https://assets.example.com/fonts/body.woff2"))
      .toBeVisible();
    expect(document.querySelector(".resource-icon-json")).toBeNull();
  });

  it("keeps the existing inspector text and actions when the type is unknown or missing", async () => {
    const flowDetail = inspectorDetail("unknown", "/download");
    const unknown = summary({
      id: "unknown",
      mime: "application/octet-stream",
      kind: "other",
    });
    const screen = await render(
      <InspectorHarness flowDetail={flowDetail} flowSummary={unknown} viewer={false} />,
    );

    expect(document.querySelector(".inspector-resource-icon-slot")).toBeNull();
    await expect.element(screen.getByText("GET")).toBeVisible();
    await expect.element(screen.getByText("200")).toBeVisible();
    await expect.element(screen.getByText("https://assets.example.com/download")).toBeVisible();
    await expect.element(screen.getByTitle("Copy URL")).toBeVisible();
    await expect.element(screen.getByTitle("Copy as cURL")).toBeVisible();
    await expect
      .element(screen.getByTitle("Create an autoresponder rule seeded from this response"))
      .toBeVisible();

    await screen.rerender(<InspectorHarness flowDetail={flowDetail} />);
    expect(document.querySelector(".inspector-resource-icon-slot")).toBeNull();
    await expect.element(screen.getByText("https://assets.example.com/download")).toBeVisible();
  });
});
