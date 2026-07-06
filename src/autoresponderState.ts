import type { AutoResponderSummary, RuleSummary } from "./types";

export function ruleLabel(url: string): string {
  return url || "*";
}

function updateScenarioRules(
  state: AutoResponderSummary,
  scenarioId: string,
  update: (rules: RuleSummary[]) => RuleSummary[],
): AutoResponderSummary {
  return {
    ...state,
    scenarios: state.scenarios.map((scenario) =>
      scenario.id === scenarioId ? { ...scenario, rules: update(scenario.rules) } : scenario,
    ),
  };
}

export function appendRuleSummary(
  state: AutoResponderSummary,
  scenarioId: string,
  rule: RuleSummary,
): AutoResponderSummary {
  return updateScenarioRules(state, scenarioId, (rules) => [...rules, rule]);
}

export function replaceRuleSummary(
  state: AutoResponderSummary,
  scenarioId: string,
  rule: RuleSummary,
): AutoResponderSummary {
  return updateScenarioRules(state, scenarioId, (rules) =>
    rules.map((candidate) => (candidate.id === rule.id ? rule : candidate)),
  );
}

export function removeRuleSummary(
  state: AutoResponderSummary,
  scenarioId: string,
  ruleId: string,
): AutoResponderSummary {
  return updateScenarioRules(state, scenarioId, (rules) =>
    rules.filter((rule) => rule.id !== ruleId),
  );
}

export function insertRuleSummaryAfter(
  state: AutoResponderSummary,
  scenarioId: string,
  afterRuleId: string,
  rule: RuleSummary,
): AutoResponderSummary {
  return updateScenarioRules(state, scenarioId, (current) => {
    const index = current.findIndex((candidate) => candidate.id === afterRuleId);
    if (index === -1) return current;
    const rules = [...current];
    rules.splice(index + 1, 0, rule);
    return rules;
  });
}

export function reorderRuleSummary(
  state: AutoResponderSummary,
  scenarioId: string,
  ruleId: string,
  toId: string,
): AutoResponderSummary {
  return updateScenarioRules(state, scenarioId, (current) => {
    const from = current.findIndex((rule) => rule.id === ruleId);
    const to = current.findIndex((rule) => rule.id === toId);
    if (from === -1 || to === -1) return current;
    const rules = [...current];
    const [moved] = rules.splice(from, 1);
    rules.splice(to, 0, moved);
    return rules;
  });
}

export function appendBulkRuleSummaries(
  state: AutoResponderSummary,
  scenarioId: string,
  rules: RuleSummary[],
): AutoResponderSummary {
  const exists = state.scenarios.some((scenario) => scenario.id === scenarioId);
  const scenarios = exists
    ? state.scenarios.map((scenario) =>
        scenario.id === scenarioId
          ? { ...scenario, rules: [...scenario.rules, ...rules] }
          : scenario,
      )
    : [...state.scenarios, { id: scenarioId, name: "My mocks", rules }];
  return { ...state, scenarios, activeScenarioId: scenarioId };
}
