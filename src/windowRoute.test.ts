import { describe, expect, it } from "vitest";

import { resolveWindowRoute } from "./windowRoute";

describe("resolveWindowRoute", () => {
  it("routes a Settings session without disturbing existing window routes", () => {
    expect(resolveWindowRoute("?settings=session-1")).toEqual({
      kind: "settings",
      sessionId: "session-1",
    });
    expect(resolveWindowRoute("?rule=r1&scenario=s1")).toEqual({
      kind: "rule",
      ruleId: "r1",
      scenarioId: "s1",
    });
    expect(resolveWindowRoute("?compare=1")).toEqual({ kind: "compare" });
    expect(resolveWindowRoute("?scripts=1")).toEqual({ kind: "scripts" });
    expect(resolveWindowRoute("")).toEqual({ kind: "app" });
  });
});
