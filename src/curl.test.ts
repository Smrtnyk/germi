import { describe, expect, it } from "vitest";
import { headersToText, parseCookies, parseQuery, toCurl } from "./curl";
import { detail, message } from "./flowFixtures";

describe("toCurl", () => {
  it("renders a bare GET without -X or a body", () => {
    expect(toCurl(detail())).toBe("curl 'https://example.com/'");
  });

  it("adds -X for non-GET methods without changing their case", () => {
    expect(toCurl(detail({ method: "post" }))).toContain("-X 'post'");
    expect(toCurl(detail())).not.toContain("-X");
  });

  it("uses curl's no-body mode for HEAD instead of only changing the method string", () => {
    const out = toCurl(detail({ method: "HEAD" }));
    expect(out).toContain("--head");
    expect(out).not.toContain("-X 'HEAD'");
  });

  it("includes the request body only when size > 0", () => {
    const withBody = toCurl(
      detail({ method: "POST", request: message({ bodyText: "hello", size: 5 }) }),
    );
    expect(withBody).toContain("--data-binary 'hello'");

    const emptyBody = toCurl(
      detail({ method: "POST", request: message({ bodyText: "hello", size: 0 }) }),
    );
    expect(emptyBody).not.toContain("--data-binary");
  });

  it("keeps -X GET when a GET carries a body", () => {
    const out = toCurl(detail({ request: message({ bodyText: "q=1", size: 3 }) }));
    expect(out).toContain("-X 'GET'");
    expect(out).toContain("--data-binary 'q=1'");
  });

  it("skips hop-by-hop headers but keeps the rest", () => {
    const out = toCurl(
      detail({
        request: message({
          headers: [
            ["Host", "example.com"],
            ["Content-Length", "5"],
            ["Connection", "keep-alive, X-Connection-Only"],
            ["Transfer-Encoding", "chunked"],
            ["Trailer", "X-Checksum"],
            ["X-Connection-Only", "drop"],
            ["X-Keep", "yes"],
          ],
        }),
      }),
    );
    expect(out).not.toContain("Host:");
    expect(out).not.toContain("Content-Length");
    expect(out).not.toContain("Transfer-Encoding");
    expect(out).not.toContain("X-Connection-Only");
    expect(out).toContain("-H 'X-Keep: yes'");
  });

  it("shell-escapes single quotes in header values", () => {
    const out = toCurl(detail({ request: message({ headers: [["X-Test", "it's"]] }) }));
    expect(out).toContain("-H 'X-Test: it'\\''s'");
  });

  it("shell-quotes captured method tokens", () => {
    const out = toCurl(detail({ method: "`whoami`" }));
    expect(out).toContain("-X '`whoami`'");
    expect(out).not.toContain("-X `whoami`");
  });

  it("prefers the captured absolute URI including its non-default port", () => {
    expect(
      toCurl(
        detail({
          uri: "http://localhost:4317/v1/traces",
          scheme: "http",
          host: "localhost",
          path: "/v1/traces",
        }),
      ),
    ).toContain("curl 'http://localhost:4317/v1/traces'");
  });

  it("pipes binary request bytes from base64 without lossy text conversion", () => {
    const out = toCurl(
      detail({
        method: "POST",
        request: message({ bodyText: "�", bodyBase64: "AP/+gA==", size: 4 }),
      }),
    );
    expect(out).toContain("printf %s 'AP/+gA==' | base64 --decode | curl");
    expect(out).toContain("--data-binary @-");
    expect(out).not.toContain("�");
  });

  it("keeps encoding for raw compressed bytes and drops it for decoded bytes", () => {
    const raw = toCurl(
      detail({
        method: "POST",
        request: message({
          headers: [["Content-Encoding", "gzip"]],
          bodyBase64: "H4sIAAAAAAAA",
          size: 9,
          encoding: "gzip",
          decoded: false,
        }),
      }),
    );
    expect(raw).toContain("Content-Encoding: gzip");

    const decoded = toCurl(
      detail({
        method: "POST",
        request: message({
          headers: [["Content-Encoding", "gzip"]],
          bodyText: "hello",
          size: 5,
          encoding: "gzip",
          decoded: true,
        }),
      }),
    );
    expect(decoded).not.toContain("Content-Encoding");
    expect(decoded).toContain("--data-binary 'hello'");
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
