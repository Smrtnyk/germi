import { describe, expect, it } from "vitest";

import { effectiveFilterQuery, guidedFilterTerm, quoteFilterLiteral } from "./guidedFilter";

describe("guided filter query generation", () => {
  it("maps side and part to the canonical one-term syntax", () => {
    expect(guidedFilterTerm("needle", "both", "content")).toBe('content:"needle"');
    expect(guidedFilterTerm("needle", "request", "content")).toBe('req-content:"needle"');
    expect(guidedFilterTerm("needle", "response", "content")).toBe('resp-content:"needle"');
    expect(guidedFilterTerm("needle", "both", "headers")).toBe('header:"needle"');
    expect(guidedFilterTerm("needle", "request", "bodies")).toBe('req-body:"needle"');
    expect(guidedFilterTerm("needle", "response", "bodies")).toBe('resp-body:"needle"');
  });

  it("quotes slashes, dashes, colons, quotes, and backslashes as one literal", () => {
    expect(quoteFilterLiteral('-/a:b "c" \\d')).toBe('"-/a:b \\"c\\" \\\\d"');
  });

  it("replaces its derived term without rewriting the manual query", () => {
    const manual = 'host:api -status:5xx req-cookie:"sid=a b"';
    expect(effectiveFilterQuery(manual, "first", "both", "content")).toBe(
      `${manual} content:"first"`,
    );
    expect(effectiveFilterQuery(manual, "second", "response", "headers")).toBe(
      `${manual} resp-header:"second"`,
    );
    expect(effectiveFilterQuery(manual, "", "response", "headers")).toBe(manual);
  });
});
