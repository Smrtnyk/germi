import { describe, expect, it } from "vitest";

import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  insertRuleSummaryAfter,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
  selectedTabEnabled,
} from "./autoresponderState";
import { GENERAL_SCENARIO_ID, type AutoResponderSummary, type RuleSummary } from "./types";

function rule(id: string, url = `/${id}`): RuleSummary {
  return {
    id,
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "GET", url, urlMatch: "exact" },
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
    generalActive: true,
  };
}

function ids(value: AutoResponderSummary): string[] {
  return value.scenarios[0].rules.map((candidate) => candidate.id);
}

describe("autoresponder summary updates", () => {
  it("adds, replaces and removes one rule without replacing other summaries", () => {
    const initial = state();
    const added = appendRuleSummary(initial, "scenario", rule("d"));
    const replaced = replaceRuleSummary(added, "scenario", rule("b", "/updated"));
    const removed = removeRuleSummary(replaced, "scenario", "a");

    expect(ids(removed)).toEqual(["b", "c", "d"]);
    expect(removed.scenarios[0].rules[0].matcher.url).toBe("/updated");
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
    const empty: AutoResponderSummary = {
      scenarios: [],
      activeScenarioId: null,
      generalActive: true,
    };
    const first = appendBulkRuleSummaries(empty, "bulk", [rule("a"), rule("b")]);
    const second = appendBulkRuleSummaries(first, "bulk", [rule("c")]);

    expect(second.activeScenarioId).toBe("bulk");
    expect(second.scenarios).toHaveLength(1);
    expect(ids(second)).toEqual(["a", "b", "c"]);
  });
});

describe("selectedTabEnabled (Off/On button state)", () => {
  const ar = (over: Partial<AutoResponderSummary> = {}): AutoResponderSummary => ({
    scenarios: [],
    activeScenarioId: null,
    generalActive: true,
    ...over,
  });

  it("reflects the General layer toggle when General is selected", () => {
    expect(selectedTabEnabled(GENERAL_SCENARIO_ID, ar({ generalActive: true }))).toBe(true);
    expect(selectedTabEnabled(GENERAL_SCENARIO_ID, ar({ generalActive: false }))).toBe(false);
  });

  it("reflects whether the selected scenario is the active one", () => {
    expect(selectedTabEnabled("A", ar({ activeScenarioId: "A" }))).toBe(true);
    expect(selectedTabEnabled("A", ar({ activeScenarioId: "B" }))).toBe(false);
    expect(selectedTabEnabled("A", ar({ activeScenarioId: null }))).toBe(false);
  });

  it("is independent of General when a scenario is selected", () => {
    // A disabled General layer must not make an active scenario read as off.
    expect(selectedTabEnabled("A", ar({ activeScenarioId: "A", generalActive: false }))).toBe(true);
  });

  it("nothing selected reflects whether any scenario is active", () => {
    expect(selectedTabEnabled(null, ar({ activeScenarioId: "A" }))).toBe(true);
    expect(selectedTabEnabled(null, ar({ activeScenarioId: null }))).toBe(false);
  });
});
