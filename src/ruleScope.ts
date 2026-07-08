import type { ActionSummary, RuleSearchScope, RuleSummary } from "./types";

const SHALLOW_SCOPES: ReadonlySet<RuleSearchScope> = new Set(["url", "method", "status"]);

export function isShallowScope(scope: RuleSearchScope): boolean {
  return SHALLOW_SCOPES.has(scope);
}

function actionStatus(action: ActionSummary): string {
  return "status" in action ? String(action.status) : "";
}

/** A Map Remote's target counts as URL text, mirroring the backend's
 *  `action_url_text` — searching "localhost:8080" finds the mappings. */
function actionUrl(action: ActionSummary): string {
  return action.kind === "mapRemote" ? action.url : "";
}

function shallowFieldFor(rule: RuleSummary, scope: RuleSearchScope): string {
  switch (scope) {
    case "url":
      return `${rule.matcher.url}\n${actionUrl(rule.action)}`;
    case "method":
      return rule.matcher.method ?? "";
    case "status":
      return actionStatus(rule.action);
    default:
      return "";
  }
}

export function ruleMatchesScopeClient(
  rule: RuleSummary,
  scope: RuleSearchScope,
  needle: string,
): boolean {
  if (!needle) return true;
  return shallowFieldFor(rule, scope).toLowerCase().includes(needle.toLowerCase());
}
