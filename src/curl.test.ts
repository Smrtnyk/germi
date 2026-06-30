import { describe, expect, it } from "vitest";
import { headersToText, parseCookies, parseQuery, toCurl } from "./curl";
import { detail, message } from "./flowFixtures";

describe("toCurl", () => {
  it("renders a bare GET without -X or a body", () => {
    expect(toCurl(detail())).toBe("curl 'https://example.com/'");
  });

  it("adds -X for non-GET methods, normalizing case", () => {
    expect(toCurl(detail({ method: "post" }))).toContain("-X POST");
    expect(toCurl(detail())).not.toContain("-X");
  });

  it("includes the request body only when size > 0", () => {
    const withBody = toCurl(
      detail({ method: "POST", request: message({ bodyText: "hello", size: 5 }) }),
    );
    expect(withBody).toContain("--data-raw 'hello'");

    const emptyBody = toCurl(
      detail({ method: "POST", request: message({ bodyText: "hello", size: 0 }) }),
    );
    expect(emptyBody).not.toContain("--data-raw");
  });

  it("skips hop-by-hop headers but keeps the rest", () => {
    const out = toCurl(
      detail({
        request: message({
          headers: [
            ["Host", "example.com"],
            ["Content-Length", "5"],
            ["X-Keep", "yes"],
          ],
        }),
      }),
    );
    expect(out).not.toContain("Host:");
    expect(out).not.toContain("Content-Length");
    expect(out).toContain("-H 'X-Keep: yes'");
  });

  it("shell-escapes single quotes in header values", () => {
    const out = toCurl(detail({ request: message({ headers: [["X-Test", "it's"]] }) }));
    expect(out).toContain("-H 'X-Test: it'\\''s'");
  });
});

describe("headersToText", () => {
  it("joins header pairs as 'k: v' lines", () => {
    expect(
      headersToText([
        ["Accept", "application/json"],
        ["X-A", "1"],
      ]),
    ).toBe("Accept: application/json\nX-A: 1");
  });

  it("returns an empty string for no headers", () => {
    expect(headersToText([])).toBe("");
  });
});

describe("parseQuery", () => {
  it("returns no pairs when there is no query string", () => {
    expect(parseQuery("/path")).toEqual([]);
    expect(parseQuery("/path?")).toEqual([]);
  });

  it("splits decoded key/value pairs", () => {
    expect(parseQuery("/search?q=hello+world&page=2")).toEqual([
      { key: "q", value: "hello world" },
      { key: "page", value: "2" },
    ]);
  });

  it("percent-decodes values", () => {
    expect(parseQuery("/x?name=a%20b")).toEqual([{ key: "name", value: "a b" }]);
  });

  it("treats a key without '=' as an empty value and skips empty pairs", () => {
    expect(parseQuery("/x?flag&a=1&&b=2")).toEqual([
      { key: "flag", value: "" },
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("falls back to the raw value on a malformed escape", () => {
    expect(parseQuery("/x?bad=%zz")).toEqual([{ key: "bad", value: "%zz" }]);
  });
});

describe("parseCookies", () => {
  it("parses request Cookie pairs, trimming whitespace", () => {
    expect(parseCookies([["Cookie", "a=1; b=2"]], "request")).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("returns nothing when the request has no Cookie header", () => {
    expect(parseCookies([["Accept", "*/*"]], "request")).toEqual([]);
  });

  it("reads names and values from each Set-Cookie response header", () => {
    expect(
      parseCookies(
        [
          ["Set-Cookie", "sid=abc; Path=/; HttpOnly"],
          ["set-cookie", "tok=xyz; Secure"],
        ],
        "response",
      ),
    ).toEqual([
      { key: "sid", value: "abc" },
      { key: "tok", value: "xyz" },
    ]);
  });
});
