import { describe, expect, it } from "vitest";

import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  insertRuleSummaryAfter,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
} from "./autoresponderState";
import type { AutoResponderSummary, RuleSummary } from "./types";

function rule(id: string, name = id): RuleSummary {
  return {
    id,
    name,
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "GET", url: `/${id}`, urlMatch: "exact" },
    action: {
      kind: "respond",
      status: 200,
      contentType: "application/json",
      contentEncoding: null,
    },
  };
}

function state(): AutoResponderSummary {
  return {
    scenarios: [{ id: "scenario", name: "Scenario", rules: [rule("a"), rule("b"), rule("c")] }],
    activeScenarioId: "scenario",
  };
}

function ids(value: AutoResponderSummary): string[] {
  return value.scenarios[0].rules.map((candidate) => candidate.id);
}

describe("autoresponder summary updates", () => {
  it("adds, replaces and removes one rule without replacing other summaries", () => {
    const initial = state();
    const added = appendRuleSummary(initial, "scenario", rule("d"));
    const replaced = replaceRuleSummary(added, "scenario", rule("b", "Updated"));
    const removed = removeRuleSummary(replaced, "scenario", "a");

    expect(ids(removed)).toEqual(["b", "c", "d"]);
    expect(removed.scenarios[0].rules[0].name).toBe("Updated");
    expect(initial.scenarios[0].rules).toHaveLength(3);
  });

  it("inserts a duplicate immediately after its source", () => {
    expect(ids(insertRuleSummaryAfter(state(), "scenario", "b", rule("b-copy")))).toEqual([
      "a",
      "b",
      "b-copy",
      "c",
    ]);
  });

  it("matches backend reorder semantics in both directions", () => {
    expect(ids(reorderRuleSummary(state(), "scenario", "a", "c"))).toEqual(["b", "c", "a"]);
    expect(ids(reorderRuleSummary(state(), "scenario", "c", "a"))).toEqual(["c", "a", "b"]);
  });

  it("creates a bulk scenario once and appends later chunks", () => {
    const empty: AutoResponderSummary = { scenarios: [], activeScenarioId: null };
    const first = appendBulkRuleSummaries(empty, "bulk", [rule("a"), rule("b")]);
    const second = appendBulkRuleSummaries(first, "bulk", [rule("c")]);

    expect(second.activeScenarioId).toBe("bulk");
    expect(second.scenarios).toHaveLength(1);
    expect(ids(second)).toEqual(["a", "b", "c"]);
  });
});
