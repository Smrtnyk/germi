export type WindowRoute =
  | { kind: "rule"; ruleId: string; scenarioId: string }
  | { kind: "compare" }
  | { kind: "scripts" }
  | { kind: "settings"; sessionId: string }
  | { kind: "app" };

export function resolveWindowRoute(search: string): WindowRoute {
  const params = new URLSearchParams(search);
  const ruleId = params.get("rule");
  const scenarioId = params.get("scenario");
  if (ruleId && scenarioId) return { kind: "rule", ruleId, scenarioId };
  if (params.get("compare")) return { kind: "compare" };
  if (params.get("scripts")) return { kind: "scripts" };
  const settingsSession = params.get("settings");
  if (settingsSession) return { kind: "settings", sessionId: settingsSession };
  return { kind: "app" };
}
