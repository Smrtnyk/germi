import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { detail, message, summary } from "../flowFixtures";
import type { InspectorFindHandle } from "../inspectorFind";
import { FlowInspector, VirtualText } from "./FlowInspector";

const LINES = 5;
const ROW_H = 18;
const TEXT = Array.from({ length: LINES }, (_, i) => `${i}${"x".repeat(299)}`).join("\n");
const SVG = '<svg id="decoded-response" xmlns="http://www.w3.org/2000/svg"></svg>';
const FLOW_SUMMARY = summary({ mime: "image/svg+xml", respSize: SVG.length });
const FLOW_DETAIL = detail({
  response: message({
    headers: [
      ["content-type", "image/svg+xml"],
      ["content-encoding", "gzip"],
    ],
    bodyText: SVG,
    size: SVG.length,
    encoding: "gzip",
    decoded: true,
  }),
});
const INSPECTOR_FIND_REF = createRef<InspectorFindHandle>();

class ControlledResizeObserver implements ResizeObserver {
  static instances = new Set<ControlledResizeObserver>();

  private targets = new Set<Element>();

  constructor(_callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  static observes(target: Element): boolean {
    return [...this.instances].some((observer) => observer.targets.has(target));
  }

  static reset() {
    this.instances.clear();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  ControlledResizeObserver.reset();
});

function Harness({ wrap }: { wrap: boolean }) {
  return (
    <div style={{ width: "240px", height: "300px", display: "flex", flexDirection: "column" }}>
      <VirtualText text={TEXT} wrap={wrap} />
    </div>
  );
}

function InspectorHarness({ active }: { active: boolean }) {
  return (
    <div className="right-content" style={{ width: "720px", height: "520px" }}>
      <div className={active ? "pane" : "pane hidden"}>
        <FlowInspector
          active={active}
          detail={FLOW_DETAIL}
          summary={FLOW_SUMMARY}
          loading={false}
          decode
          onMock={() => {}}
          onCopyCurl={() => {}}
          onLoadFull={() => {}}
          selectedSummaries={[FLOW_SUMMARY]}
          onSelectOne={() => {}}
          onMockMany={() => {}}
          onCompare={() => {}}
          onClearSelection={() => {}}
          inspectorFindRef={INSPECTOR_FIND_REF}
          viewer={false}
        />
      </div>
    </div>
  );
}

function canvasHeight(): number {
  const canvas = document.querySelector<HTMLElement>(".vtext-canvas");
  return canvas ? parseFloat(canvas.style.height) : 0;
}

describe("VirtualText", () => {
  it("flushes wrapped row measurements when wrap is toggled off", async () => {
    const screen = await render(<Harness wrap />);
    await vi.waitFor(() => expect(canvasHeight()).toBeGreaterThan(LINES * ROW_H * 2));

    await screen.rerender(<Harness wrap={false} />);

    await vi.waitFor(() => expect(canvasHeight()).toBe(LINES * ROW_H));
    for (const line of document.querySelectorAll<HTMLElement>(".vline")) {
      expect(line.offsetHeight).toBe(ROW_H);
    }
  });

  it("re-measures wrapped rows when wrap is toggled back on", async () => {
    const screen = await render(<Harness wrap={false} />);
    await vi.waitFor(() => expect(canvasHeight()).toBe(LINES * ROW_H));

    await screen.rerender(<Harness wrap />);

    await vi.waitFor(() => expect(canvasHeight()).toBeGreaterThan(LINES * ROW_H * 2));
  });

  it("reconnects the decoded body viewport after its Inspector tab is shown again", async () => {
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const screen = await render(<InspectorHarness active />);

    await vi.waitFor(() => expect(document.querySelector(".vline")?.textContent).toBe(SVG));
    const viewport = document.querySelector(".vtext-scroll");
    expect(viewport).not.toBeNull();
    expect(ControlledResizeObserver.observes(viewport!)).toBe(true);

    await screen.rerender(<InspectorHarness active={false} />);
    expect(ControlledResizeObserver.observes(viewport!)).toBe(false);

    await screen.rerender(<InspectorHarness active />);
    await vi.waitFor(() => expect(ControlledResizeObserver.observes(viewport!)).toBe(true));
    await vi.waitFor(() => expect(document.querySelector(".vline")?.textContent).toBe(SVG));
    expect(document.querySelector(".enc-chip")?.textContent).toBe("gzip · decoded");
  });
});
