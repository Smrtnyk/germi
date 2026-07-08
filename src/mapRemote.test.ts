import { describe, expect, it } from "vitest";

import { mapRemoteWarnings, numericCaptureRefs, regexGroupCount } from "./mapRemote";
import type { Matcher } from "./types";

function matcher(url: string, urlMatch: Matcher["urlMatch"]): Matcher {
  return { method: null, url, urlMatch };
}

describe("numericCaptureRefs", () => {
  it("finds bare and braced numeric references", () => {
    expect(numericCaptureRefs("http://h/$1/x_${2}_1.js")).toEqual([1, 2]);
  });

  it("stops a bare reference at the first non-digit (Fiddler-style $1_1)", () => {
    expect(numericCaptureRefs("agent_$1_1.js")).toEqual([1]);
  });

  it("skips $$ escapes and named references", () => {
    expect(numericCaptureRefs("http://h/$$1/${name}/$name")).toEqual([]);
  });

  it("returns empty for a template with no references", () => {
    expect(numericCaptureRefs("http://localhost:8080/mock")).toEqual([]);
  });
});

describe("regexGroupCount", () => {
  it("counts plain and named capture groups", () => {
    expect(regexGroupCount("a(b)(c)")).toBe(2);
    expect(regexGroupCount("(?P<name>x)(y)")).toBe(2);
  });

  it("ignores non-capturing groups", () => {
    expect(regexGroupCount("(?:a)(b)")).toBe(1);
  });

  it("returns null for a pattern that does not compile", () => {
    expect(regexGroupCount("a(b")).toBeNull();
  });
});

describe("mapRemoteWarnings", () => {
  it("flags an empty target", () => {
    expect(mapRemoteWarnings(matcher(".*", "regex"), " ")).toEqual([
      "Target URL is empty — this rule will be skipped.",
    ]);
  });

  it("flags a non-absolute target", () => {
    const warnings = mapRemoteWarnings(matcher("/api", "contains"), "/relative/path");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("absolute http(s)://");
  });

  it("accepts a target starting with a capture reference", () => {
    expect(mapRemoteWarnings(matcher("(https?)://x/(.*)", "regex"), "$1://localhost/$2")).toEqual(
      [],
    );
  });

  it("flags capture references on a non-regex matcher", () => {
    const warnings = mapRemoteWarnings(matcher("/api", "contains"), "http://h/$1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Regex matcher");
  });

  it("flags a reference beyond the pattern's group count", () => {
    const warnings = mapRemoteWarnings(matcher("agent_(\\w+)\\.js", "regex"), "http://h/$2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("$2");
    expect(warnings[0]).toContain("1 capture group");
  });

  it("accepts the issue #111 shape: $1 with literal suffix on a regex matcher", () => {
    expect(
      mapRemoteWarnings(
        matcher(".*ruxitagentjs_(\\w+)_\\d+\\.js", "regex"),
        "http://localhost:8080/ajax/ruxitagentjs_$1_1.js",
      ),
    ).toEqual([]);
  });
});
