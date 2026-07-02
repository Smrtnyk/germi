import { describe, expect, it } from "vitest";
import { urlSimilarity } from "./urlSimilarity";

describe("urlSimilarity", () => {
  it("scores identical URLs at exactly 100", () => {
    expect(urlSimilarity("https://a.com/x?y=1", "https://a.com/x?y=1")).toBe(100);
  });

  it("caps everything non-identical at 99, even semantically equal URLs", () => {
    expect(urlSimilarity("https://a.com/x", "https://a.com/x?")).toBe(99);
  });

  it("keeps a request with a random query value a near match", () => {
    const sim = urlSimilarity(
      "https://api.example.com/v1/items?page=2&session=abc123",
      "https://api.example.com/v1/items?page=2&session=zzz999",
    );
    expect(sim).toBe(95);
  });

  it("penalizes a missing query parameter more than a differing value", () => {
    const base = "https://api.example.com/v1/items?page=2&session=abc";
    const differentValue = urlSimilarity(base, "https://api.example.com/v1/items?page=2&session=x");
    const missingParam = urlSimilarity(base, "https://api.example.com/v1/items?page=2");
    expect(differentValue).toBeGreaterThan(missingParam);
  });

  it("matches path structure via subsequence, tolerating an inserted segment", () => {
    const inserted = urlSimilarity("https://a.com/api/users", "https://a.com/api/v2/users");
    const replaced = urlSimilarity("https://a.com/api/users", "https://a.com/other/thing");
    expect(inserted).toBeGreaterThan(replaced);
  });

  it("credits a shared parent domain but not a shared subdomain name", () => {
    const siblingHost = urlSimilarity("https://api.foo.com/x", "https://staging.foo.com/x");
    const otherDomain = urlSimilarity("https://api.foo.com/x", "https://api.bar.com/x");
    expect(siblingHost).toBeGreaterThan(otherDomain);
  });

  it("counts a scheme difference against the score", () => {
    expect(urlSimilarity("https://a.com/x", "http://a.com/x")).toBeLessThan(99);
  });

  it("ignores query weighting when neither URL has parameters", () => {
    expect(urlSimilarity("https://a.com/x/y", "https://a.com/x/y")).toBe(100);
    expect(urlSimilarity("https://a.com/x/y", "https://a.com/x/z")).toBeLessThan(99);
  });

  it("scores unparseable URLs as 0 unless byte-identical", () => {
    expect(urlSimilarity("not a url", "not a url")).toBe(100);
    expect(urlSimilarity("not a url", "https://a.com/")).toBe(0);
  });
});
