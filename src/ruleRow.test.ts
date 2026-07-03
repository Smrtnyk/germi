import { describe, expect, it } from "vitest";

import { actionLabel, methodColorClass, ruleRowParts, splitPattern } from "./ruleRow";
import type { ActionSummary, Matcher, RuleSummary } from "./types";

function matcher(
  url: string,
  method: string | null = "GET",
  urlMatch: Matcher["urlMatch"] = "exact",
): Matcher {
  return { url, method, urlMatch };
}

describe("splitPattern", () => {
  it("splits a full auto-mock URL (scheme + host + path)", () => {
    expect(splitPattern(matcher("https://example.com/users?q=1"))).toEqual({
      host: "example.com",
      path: "/users?q=1",
    });
  });

  it("treats the authority as host even without a dot when a scheme is present", () => {
    expect(splitPattern(matcher("http://localhost/foo"))).toEqual({
      host: "localhost",
      path: "/foo",
    });
  });

  it("keeps a bare path (leading slash) as path with no host", () => {
    expect(splitPattern(matcher("/api/health", null, "contains"))).toEqual({
      host: "",
      path: "/api/health",
    });
  });

  it("splits a schemeless host/path when the head looks like a host", () => {
    expect(splitPattern(matcher("example.com/users", "POST", "contains"))).toEqual({
      host: "example.com",
      path: "/users",
    });
  });

  it("treats a host:port authority as host", () => {
    expect(splitPattern(matcher("localhost:3000/api", "GET", "contains"))).toEqual({
      host: "localhost:3000",
      path: "/api",
    });
  });

  it("keeps a non-host substring verbatim as the path", () => {
    expect(splitPattern(matcher("api", "GET", "contains"))).toEqual({ host: "", path: "api" });
  });

  it("shows a dotted schemeless substring verbatim (not mislabeled as a host)", () => {
    expect(splitPattern(matcher("app.min.js", "GET", "contains"))).toEqual({
      host: "",
      path: "app.min.js",
    });
  });

  it("shows regex patterns verbatim, never split", () => {
    expect(splitPattern(matcher("^/v\\d+/users", "GET", "regex"))).toEqual({
      host: "",
      path: "^/v\\d+/users",
    });
  });

  it("returns empty parts for an empty pattern", () => {
    expect(splitPattern(matcher("", null, "exact"))).toEqual({ host: "", path: "" });
  });

  it("shows a bare schemeless host substring verbatim (ambiguous, so not split)", () => {
    expect(splitPattern(matcher("example.com", "GET", "contains"))).toEqual({
      host: "",
      path: "example.com",
    });
  });

  it("splits a bare host only when a scheme proves it is one", () => {
    expect(splitPattern(matcher("https://example.com", "GET", "exact"))).toEqual({
      host: "example.com",
      path: "",
    });
  });
});

describe("methodColorClass", () => {
  it("maps the colored methods to their m-* class", () => {
    expect(methodColorClass("GET")).toBe("m-get");
    expect(methodColorClass("delete")).toBe("m-delete");
    expect(methodColorClass("PATCH")).toBe("m-patch");
  });

  it("returns null for ANY (null) and uncolored methods", () => {
    expect(methodColorClass(null)).toBeNull();
    expect(methodColorClass("HEAD")).toBeNull();
    expect(methodColorClass("OPTIONS")).toBeNull();
  });
});

describe("actionLabel", () => {
  it("summarizes a respond action with status + content type", () => {
    const a: ActionSummary = {
      kind: "respond",
      status: 200,
      contentType: "application/json; charset=utf-8",
      contentEncoding: null,
    };
    expect(actionLabel(a)).toBe("200 application/json");
  });

  it("appends the content encoding when present", () => {
    const a: ActionSummary = {
      kind: "respond",
      status: 200,
      contentType: "text/html",
      contentEncoding: "gzip",
    };
    expect(actionLabel(a)).toBe("200 text/html · gzip");
  });

  it("labels the non-respond actions", () => {
    expect(actionLabel({ kind: "mapLocal", status: 200 })).toBe("file → 200");
    expect(actionLabel({ kind: "block" })).toBe("block 403");
    expect(actionLabel({ kind: "setStatus", status: 404 })).toBe("status 404");
    expect(actionLabel({ kind: "setResponseHeader", name: "X-Cache" })).toBe("resp X-Cache");
    expect(actionLabel({ kind: "setRequestHeader", name: "" })).toBe("req header");
    expect(actionLabel({ kind: "rewriteResponseBody" })).toBe("rewrite body");
    expect(actionLabel({ kind: "cors" })).toBe("allow CORS");
  });
});

describe("ruleRowParts", () => {
  const summary = (over: Partial<RuleSummary> = {}): RuleSummary => ({
    id: "r1",
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: matcher("https://example.com/users"),
    action: {
      kind: "respond",
      status: 200,
      contentType: "application/json",
      contentEncoding: null,
    },
    ...over,
  });

  it("builds the compact parts for an auto-mock rule (method + host/path + action)", () => {
    expect(ruleRowParts(summary())).toEqual({
      method: "GET",
      methodClass: "m-get",
      host: "example.com",
      path: "/users",
      action: "200 application/json",
    });
  });

  it("handles an ANY method and a bare path", () => {
    const parts = ruleRowParts(
      summary({
        matcher: matcher("/api/health", null, "contains"),
        action: { kind: "block" },
      }),
    );
    expect(parts.method).toBe("ANY");
    expect(parts.methodClass).toBeNull();
    expect(parts.host).toBe("");
    expect(parts.path).toBe("/api/health");
    expect(parts.action).toBe("block 403");
  });
});
