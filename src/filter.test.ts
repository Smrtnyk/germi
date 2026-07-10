import { describe, expect, it } from "vitest";
import { parseFilter, rawSegments, statusClass } from "./filter";
import type { FlowSummary } from "./types";

function summary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
    seq: 1,
    method: "GET",
    host: "example.com",
    path: "/",
    scheme: "https",
    status: 200,
    mime: null,
    kind: "xhr",
    reqSize: 0,
    respSize: 0,
    durationMs: null,
    ttfbMs: null,
    matchedRule: null,
    timestampMs: 0,
    comment: null,
    availability: null,
    imported: false,
    extra: {},
    ...overrides,
  };
}

function matches(filter: string, s: FlowSummary): boolean {
  return parseFilter(filter).matchSummary(s);
}

describe("parseFilter summary matching", () => {
  it("matches everything on an empty filter", () => {
    expect(matches("", summary())).toBe(true);
    expect(matches("   ", summary())).toBe(true);
  });

  it("matches a bare word as a case-insensitive substring of the request line", () => {
    const s = summary({ host: "api.example.com", path: "/users" });
    expect(matches("API", s)).toBe(true);
    expect(matches("users", s)).toBe(true);
    expect(matches("get", s)).toBe(true);
    expect(matches("absent", s)).toBe(false);
  });

  it("ANDs whitespace-separated terms", () => {
    const s = summary({ host: "api.example.com", path: "/users" });
    expect(matches("api users", s)).toBe(true);
    expect(matches("api missing", s)).toBe(false);
  });

  it("negates a term with a leading '-'", () => {
    const s = summary({ path: "/logo.png" });
    expect(matches("-png", s)).toBe(false);
    expect(matches("-json", s)).toBe(true);
  });

  it("treats a quoted phrase with a leading '-' as a literal, never a negation", () => {
    expect(matches('"-bar"', summary({ path: "/api/foo-bar" }))).toBe(true);
    expect(matches('"-bar"', summary({ path: "/api/x" }))).toBe(false);
  });

  it("negates a quoted phrase with a leading '-' (DevTools style)", () => {
    expect(matches('-"foo bar"', summary({ path: "/x/foo bar" }))).toBe(false);
    expect(matches('-"foo bar"', summary({ path: "/x/foo" }))).toBe(true);
  });

  it("parses a negated phrase plus a bare word as two terms, agreeing with rawSegments", () => {
    expect(matches('-"foo bar" x', summary({ path: "/x" }))).toBe(true);
    expect(rawSegments('-"foo bar" x')).toEqual(['-"foo bar"', "x"]);
  });

  it('keeps the key:"quoted value" form working, including negated', () => {
    expect(matches('path:"a b"', summary({ path: "/x/a b" }))).toBe(true);
    expect(matches('path:"a b"', summary({ path: "/x/a" }))).toBe(false);
    expect(matches('-path:"a b"', summary({ path: "/x/a b" }))).toBe(false);
    expect(matches('-path:"a b"', summary({ path: "/x/a" }))).toBe(true);
  });

  it("supports /regex/ terms and ignores an unparseable one", () => {
    expect(matches("/\\.js$/", summary({ path: "/app.js" }))).toBe(true);
    expect(matches("/\\.js$/", summary({ path: "/app.css" }))).toBe(false);
    expect(() => matches("/(/", summary())).not.toThrow();
  });

  describe("key:value terms", () => {
    it("matches method exactly and case-insensitively", () => {
      expect(matches("method:post", summary({ method: "POST" }))).toBe(true);
      expect(matches("method:post", summary({ method: "GET" }))).toBe(false);
    });

    it("matches host as a substring", () => {
      expect(matches("host:example", summary({ host: "api.example.com" }))).toBe(true);
      expect(matches("host:other", summary({ host: "api.example.com" }))).toBe(false);
    });

    it("supports exact, class and range status comparisons", () => {
      expect(matches("status:404", summary({ status: 404 }))).toBe(true);
      expect(matches("status:404", summary({ status: 200 }))).toBe(false);
      expect(matches("status:4xx", summary({ status: 451 }))).toBe(true);
      expect(matches("status:4xx", summary({ status: 500 }))).toBe(false);
      expect(matches("status:>=400", summary({ status: 500 }))).toBe(true);
      expect(matches("status:<500", summary({ status: 200 }))).toBe(true);
    });

    it("never matches an in-flight flow on a status term", () => {
      expect(matches("status:2xx", summary({ status: null }))).toBe(false);
    });

    it("maps kind:fetch onto the xhr kind", () => {
      expect(matches("kind:fetch", summary({ kind: "xhr" }))).toBe(true);
      expect(matches("kind:js", summary({ kind: "js" }))).toBe(true);
      expect(matches("kind:js", summary({ kind: "css" }))).toBe(false);
    });

    it("derives ext from the path", () => {
      expect(matches("ext:js", summary({ path: "/app.min.js?v=1" }))).toBe(true);
      expect(matches("ext:js", summary({ path: "/api/users" }))).toBe(false);
    });

    it("splits imported vs captured flows with is:", () => {
      const imp = summary({ imported: true });
      const cap = summary({ imported: false });
      expect(matches("is:imported", imp)).toBe(true);
      expect(matches("is:imported", cap)).toBe(false);
      expect(matches("is:captured", cap)).toBe(true);
      expect(matches("is:live", cap)).toBe(true);
      expect(matches("is:captured", imp)).toBe(false);
      // negation is the complement
      expect(matches("-is:imported", cap)).toBe(true);
      expect(matches("-is:imported", imp)).toBe(false);
      // an unknown is: value matches nothing, even negated (no flip to all)
      expect(matches("is:bogus", imp)).toBe(false);
      expect(matches("-is:bogus", imp)).toBe(false);
    });

    it("compares sizes with k/m suffixes", () => {
      expect(matches("larger-than:1k", summary({ respSize: 2000 }))).toBe(true);
      expect(matches("larger-than:1k", summary({ respSize: 500 }))).toBe(false);
      expect(matches("smaller-than:1k", summary({ respSize: 500 }))).toBe(true);
      expect(matches("req-larger-than:1k", summary({ reqSize: 2000 }))).toBe(true);
    });

    it("compares duration with slower-than", () => {
      expect(matches("slower-than:100", summary({ durationMs: 250 }))).toBe(true);
      expect(matches("slower-than:100", summary({ durationMs: 50 }))).toBe(false);
      expect(matches("slower-than:100", summary({ durationMs: null }))).toBe(false);
    });

    it("treats a bare matched: term as 'has any mock'", () => {
      expect(matches("matched:", summary({ matchedRule: "Rule A" }))).toBe(true);
      expect(matches("matched:", summary({ matchedRule: null }))).toBe(false);
      expect(matches("rule:a", summary({ matchedRule: "Rule A" }))).toBe(true);
    });

    it("matches nothing for an invalid numeric value, even when negated", () => {
      expect(matches("status:", summary({ status: 200 }))).toBe(false);
      expect(matches("-status:", summary({ status: 200 }))).toBe(false);
      expect(matches("larger-than:abc", summary({ respSize: 9999 }))).toBe(false);
      expect(matches("-larger-than:abc", summary({ respSize: 9999 }))).toBe(false);
    });
  });
});

describe("parseFilter content terms", () => {
  it("extracts body terms without affecting summary matching", () => {
    const parsed = parseFilter("body:secret");
    expect(parsed.matchSummary(summary())).toBe(true);
    expect(parsed.contentTerms).toEqual([
      { field: "body", side: "either", value: "secret", regex: false, neg: false },
    ]);
  });

  it("distinguishes side, regex and negation for body terms", () => {
    const parsed = parseFilter("req-body:token -resp-body:/foo/");
    expect(parsed.contentTerms).toEqual([
      { field: "body", side: "request", value: "token", regex: false, neg: false },
      { field: "body", side: "response", value: "foo", regex: true, neg: true },
    ]);
  });

  it("extracts a header term scoped to either side", () => {
    const parsed = parseFilter("header:authorization");
    expect(parsed.contentTerms).toEqual([
      { field: "headers", side: "either", value: "authorization", regex: false, neg: false },
    ]);
  });

  it("distinguishes side, regex and negation for header terms", () => {
    const parsed = parseFilter("req-header:x-foo -resp-header:/bar/");
    expect(parsed.contentTerms).toEqual([
      { field: "headers", side: "request", value: "x-foo", regex: false, neg: false },
      { field: "headers", side: "response", value: "bar", regex: true, neg: true },
    ]);
  });

  it("mixes body and header terms, one per field", () => {
    const parsed = parseFilter("body:secret header:x-token");
    expect(parsed.contentTerms).toEqual([
      { field: "body", side: "either", value: "secret", regex: false, neg: false },
      { field: "headers", side: "either", value: "x-token", regex: false, neg: false },
    ]);
  });

  it("drops an empty body or header value", () => {
    expect(parseFilter("body:").contentTerms).toEqual([]);
    expect(parseFilter("header:").contentTerms).toEqual([]);
  });
});

describe("rawSegments", () => {
  it("splits on whitespace while preserving quoted phrases", () => {
    expect(rawSegments('method:get "foo bar" baz')).toEqual(["method:get", '"foo bar"', "baz"]);
  });

  it("returns no segments for blank input", () => {
    expect(rawSegments("   ")).toEqual([]);
  });

  it("round-trips back to the original query via join", () => {
    const q = 'host:example -status:200 "a b"';
    expect(rawSegments(q).join(" ")).toBe(q);
  });
});

describe("statusClass", () => {
  it("buckets a status into its class", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(301)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });

  it("reports a null status as pending", () => {
    expect(statusClass(null)).toBe("pending");
  });
});
