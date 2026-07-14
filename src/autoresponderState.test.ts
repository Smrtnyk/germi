import { describe, expect, it, vi } from "vitest";

import {
  appendBulkRuleSummaries,
  appendRuleSummary,
  harRulesOfferMessage,
  insertRuleSummaryAfter,
  mockingRuleCount,
  popOutOpener,
  removeRuleSummary,
  reorderRuleSummary,
  replaceRuleSummary,
  seededRuleId,
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

  it("keeps the active scenario when a bulk drop appends to General", () => {
    const initial: AutoResponderSummary = {
      scenarios: [
        { id: GENERAL_SCENARIO_ID, name: "General rules", rules: [rule("g1")] },
        { id: "active", name: "Active", rules: [] },
      ],
      activeScenarioId: "active",
      generalActive: true,
    };

    const next = appendBulkRuleSummaries(initial, GENERAL_SCENARIO_ID, [rule("g2")]);

    expect(next.activeScenarioId).toBe("active");
    expect(next.scenarios[0].rules.map((candidate) => candidate.id)).toEqual(["g1", "g2"]);
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

describe("popOutOpener (detached rule window)", () => {
  const idleEditor = { rule: null, flush: () => Promise.resolve() };

  it("opens under the viewed scenario, not the active one (General tab pop-out)", () => {
    const open = vi.fn();
    popOutOpener(GENERAL_SCENARIO_ID, idleEditor, open)("r1");
    expect(open).toHaveBeenCalledWith(GENERAL_SCENARIO_ID, "r1");
  });

  it("opens an inactive scenario's rule under that scenario", () => {
    const open = vi.fn();
    popOutOpener("viewed", idleEditor, open)("r1");
    expect(open).toHaveBeenCalledWith("viewed", "r1");
  });

  it("flushes the inline editor first when popping out the rule being edited", async () => {
    const order: string[] = [];
    const editor = {
      rule: { id: "r1" },
      flush: () => {
        order.push("flush");
        return Promise.resolve();
      },
    };
    const open = vi.fn(() => order.push("open"));
    popOutOpener("viewed", editor, open)("r1");
    expect(open).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(order).toEqual(["flush", "open"]);
    expect(open).toHaveBeenCalledWith("viewed", "r1");
  });

  it("skips the flush when a different rule is being edited", () => {
    const open = vi.fn();
    popOutOpener("viewed", { rule: { id: "other" }, flush: () => Promise.resolve() }, open)("r1");
    expect(open).toHaveBeenCalledWith("viewed", "r1");
  });

  it("does not open a second editor when the current edit cannot be flushed", async () => {
    const open = vi.fn();
    popOutOpener(
      "viewed",
      { rule: { id: "r1" }, flush: () => Promise.reject(new Error("read-only")) },
      open,
    )("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("seededRuleId (one-shot Mock-this selection seed)", () => {
  it("yields the rule id when the viewed scenario is the one the mock landed in", () => {
    expect(seededRuleId({ scenarioId: "s1", ruleId: "r7" }, "s1")).toBe("r7");
  });

  it("yields null for a seed that landed in another scenario", () => {
    expect(seededRuleId({ scenarioId: "s2", ruleId: "r7" }, "s1")).toBeNull();
  });

  it("yields null without a seed", () => {
    expect(seededRuleId(null, "s1")).toBeNull();
    expect(seededRuleId(undefined, "s1")).toBeNull();
  });
});

describe("mockingRuleCount (save-options gate)", () => {
  const ar = (over: Partial<AutoResponderSummary> = {}): AutoResponderSummary => ({
    scenarios: [
      { id: GENERAL_SCENARIO_ID, name: "General rules", rules: [rule("g")] },
      { id: "A", name: "A", rules: [rule("a1"), rule("a2")] },
      { id: "B", name: "B", rules: [rule("b1")] },
    ],
    activeScenarioId: "A",
    generalActive: true,
    ...over,
  });

  it("counts the active scenario plus the General layer, never idle scenarios", () => {
    expect(mockingRuleCount(ar())).toBe(3);
  });

  it("drops General when its layer is off and everything when nothing mocks", () => {
    expect(mockingRuleCount(ar({ generalActive: false }))).toBe(2);
    expect(mockingRuleCount(ar({ activeScenarioId: null }))).toBe(1);
    expect(mockingRuleCount(ar({ activeScenarioId: null, generalActive: false }))).toBe(0);
  });
});

describe("harRulesOfferMessage", () => {
  it("lists every embedded scenario with its rule count", () => {
    const message = harRulesOfferMessage([
      { name: "General rules", ruleCount: 1 },
      { name: "Checkout", ruleCount: 5 },
    ]);
    expect(message).toContain("General rules (1 rule)");
    expect(message).toContain("Checkout (5 rules)");
    expect(message).toContain("new scenarios");
  });
});
