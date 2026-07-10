import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { VirtualText } from "./FlowInspector";

const LINES = 5;
const ROW_H = 18;
const TEXT = Array.from({ length: LINES }, (_, i) => `${i}${"x".repeat(299)}`).join("\n");

function Harness({ wrap }: { wrap: boolean }) {
  return (
    <div style={{ width: "240px", height: "300px", display: "flex", flexDirection: "column" }}>
      <VirtualText text={TEXT} wrap={wrap} />
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
});
