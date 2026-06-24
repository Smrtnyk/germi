import { describe, expect, it } from "vitest";

import { isShallowScope, ruleMatchesScopeClient } from "./ruleScope";
import type { ActionSummary, RuleSummary } from "./types";

function rule(overrides: Partial<RuleSummary> = {}, action?: ActionSummary): RuleSummary {
  return {
    id: "r1",
    name: "Login mock",
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "POST", url: "/api/login", urlMatch: "contains" },
    action: action ?? {
      kind: "respond",
      status: 503,
      contentType: "application/json",
      contentEncoding: null,
    },
    ...overrides,
  };
}

describe("isShallowScope", () => {
  it("treats name/url/method/status as shallow", () => {
    expect(isShallowScope("name")).toBe(true);
    expect(isShallowScope("url")).toBe(true);
    expect(isShallowScope("method")).toBe(true);
    expect(isShallowScope("status")).toBe(true);
  });

  it("treats response/headers/all as deep", () => {
    expect(isShallowScope("response")).toBe(false);
    expect(isShallowScope("headers")).toBe(false);
    expect(isShallowScope("all")).toBe(false);
  });
});

describe("ruleMatchesScopeClient", () => {
  it("matches on name case-insensitively", () => {
    expect(ruleMatchesScopeClient(rule(), "name", "login")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "name", "LOGIN")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "name", "logout")).toBe(false);
  });

  it("matches on url substring", () => {
    expect(ruleMatchesScopeClient(rule(), "url", "/api")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "url", "/static")).toBe(false);
  });

  it("matches on method", () => {
    expect(ruleMatchesScopeClient(rule(), "method", "post")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "method", "get")).toBe(false);
  });

  it("matches a null method against nothing", () => {
    const r = rule({ matcher: { method: null, url: "/x", urlMatch: "contains" } });
    expect(ruleMatchesScopeClient(r, "method", "get")).toBe(false);
  });

  it("matches status from a status-bearing action's summary", () => {
    expect(ruleMatchesScopeClient(rule(), "status", "503")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "status", "200")).toBe(false);
    const setStatus = rule({}, { kind: "setStatus", status: 418 });
    expect(ruleMatchesScopeClient(setStatus, "status", "418")).toBe(true);
  });

  it("matches no status for a status-free action", () => {
    const block = rule({}, { kind: "block" });
    expect(ruleMatchesScopeClient(block, "status", "200")).toBe(false);
  });

  it("matches every rule on an empty query", () => {
    expect(ruleMatchesScopeClient(rule(), "name", "")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "status", "")).toBe(true);
  });

  it("never claims a match for a deep scope with a non-empty query", () => {
    expect(ruleMatchesScopeClient(rule(), "response", "anything")).toBe(false);
    expect(ruleMatchesScopeClient(rule(), "headers", "anything")).toBe(false);
    expect(ruleMatchesScopeClient(rule(), "all", "anything")).toBe(false);
  });

  it("short-circuits an empty query to true even for a deep scope", () => {
    expect(ruleMatchesScopeClient(rule(), "all", "")).toBe(true);
    expect(ruleMatchesScopeClient(rule(), "response", "")).toBe(true);
  });
});
