import { GENERAL_SCENARIO_ID, type AutoResponderSummary, type RuleSummary } from "./types";

export function ruleLabel(url: string): string {
  return url || "*";
}

/**
 * Whether the currently-selected autoresponder tab's rules are enabled: the
 * General layer → its own toggle; a scenario → whether it's the active one;
 * nothing selected → whether any scenario is active. Drives the Off/On button.
 */
export function selectedTabEnabled(viewedId: string | null, ar: AutoResponderSummary): boolean {
  if (viewedId === GENERAL_SCENARIO_ID) return ar.generalActive;
  if (viewedId === null) return ar.activeScenarioId !== null;
  return viewedId === ar.activeScenarioId;
}

/**
 * Pop-out handler for a rule row: flushes the inline editor's pending debounced
 * edit first when that rule is the one being edited, and always opens the window
 * under the VIEWED scenario — which may be the General layer or an inactive tab,
 * never resolved from the active scenario (the detached editor would save into
 * the wrong scenario).
 */
export function popOutOpener(
  viewedScenarioId: string,
  editor: { rule: { id: string } | null; flush: () => Promise<void> },
  open: (scenarioId: string, ruleId: string) => void,
): (ruleId: string) => void {
  return (ruleId) => {
    if (editor.rule?.id === ruleId) {
      void editor.flush().then(() => open(viewedScenarioId, ruleId));
    } else {
      open(viewedScenarioId, ruleId);
    }
  };
}

export interface RuleSeed {
  scenarioId: string;
  ruleId: string;
}

export function seededRuleId(
  seed: RuleSeed | null | undefined,
  viewedScenarioId: string,
): string | null {
  return seed && seed.scenarioId === viewedScenarioId ? seed.ruleId : null;
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
