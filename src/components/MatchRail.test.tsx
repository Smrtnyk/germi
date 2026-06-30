import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { FlowSummary } from "../types";
import { MatchRail } from "./MatchRail";

function flows(n: number): FlowSummary[] {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i}` }) as FlowSummary);
}

function matched(n: number): Set<string> {
  return new Set(Array.from({ length: n }, (_, i) => `f${i}`));
}

describe("MatchRail", () => {
  it("renders nothing when there are no matches", async () => {
    await render(<MatchRail flows={flows(100)} matchedIds={new Set()} onJump={vi.fn()} />);
    await expect.element(page.getByTitle(/matches · drag to scan/)).not.toBeInTheDocument();
  });

  it("renders nothing when almost every flow matches", async () => {
    await render(<MatchRail flows={flows(100)} matchedIds={matched(99)} onJump={vi.fn()} />);
    await expect.element(page.getByTitle(/matches · drag to scan/)).not.toBeInTheDocument();
  });

  it("renders the rail at a useful match density", async () => {
    const screen = await render(
      <MatchRail flows={flows(100)} matchedIds={matched(5)} onJump={vi.fn()} />,
    );
    const rail = screen.getByTitle("5 matches · drag to scan");
    await expect.element(rail).toBeInTheDocument();
    await expect.element(rail).toHaveClass("match-rail");
    expect((rail.element() as HTMLElement).style.backgroundImage).toContain("linear-gradient");
  });
});
