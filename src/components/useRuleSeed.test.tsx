import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RuleSeed } from "../autoresponderState";
import { useRuleSeed, useRuleSelection } from "./AutoresponderPanel";

function Harness({
  seed,
  scenarioId,
  onConsumed,
}: {
  seed: RuleSeed | null;
  scenarioId: string;
  onConsumed: () => void;
}) {
  const selection = useRuleSelection();
  useRuleSeed(seed, scenarioId, selection.selectOne, onConsumed);
  return <output>{selection.selectedRuleId ?? "none"}</output>;
}

describe("useRuleSeed", () => {
  it("selects the seeded rule in the scenario the mock landed in, then consumes it", async () => {
    const onConsumed = vi.fn();
    const screen = await render(
      <Harness seed={{ scenarioId: "s1", ruleId: "r7" }} scenarioId="s1" onConsumed={onConsumed} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("r7");
    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it("consumes without selecting when the seed belongs to another scenario", async () => {
    const onConsumed = vi.fn();
    const screen = await render(
      <Harness seed={{ scenarioId: "s2", ruleId: "r7" }} scenarioId="s1" onConsumed={onConsumed} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("none");
    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it("does not re-apply once the seed is cleared", async () => {
    const onConsumed = vi.fn();
    const screen = await render(
      <Harness seed={{ scenarioId: "s1", ruleId: "r7" }} scenarioId="s1" onConsumed={onConsumed} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("r7");
    await screen.rerender(<Harness seed={null} scenarioId="s1" onConsumed={onConsumed} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("r7");
    expect(onConsumed).toHaveBeenCalledOnce();
  });
});
