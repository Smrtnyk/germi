import { describe, expect, it } from "vitest";
import { rawMessage, reasonPhrase, requestLine, statusLine } from "./rawHttp";
import { detail } from "./flowFixtures";

describe("reasonPhrase", () => {
  it("maps known status codes to their canonical reason", () => {
    expect(reasonPhrase(200)).toBe("OK");
    expect(reasonPhrase(404)).toBe("Not Found");
    expect(reasonPhrase(500)).toBe("Internal Server Error");
  });

  it("returns an empty string for unknown codes", () => {
    expect(reasonPhrase(299)).toBe("");
    expect(reasonPhrase(0)).toBe("");
  });
});

describe("requestLine", () => {
  it("builds an absolute-URI request line from scheme/host/path", () => {
    expect(
      requestLine(
        detail({
          method: "POST",
          uri: "/v1/x?a=1",
          scheme: "https",
          host: "api.test",
          path: "/v1/x?a=1",
        }),
      ),
    ).toBe("POST https://api.test/v1/x?a=1 HTTP/1.1");
  });

  it("preserves the captured method case and HTTP version", () => {
    expect(requestLine(detail({ method: "get", reqVersion: "HTTP/2.0" }))).toBe(
      "get https://example.com/ HTTP/2.0",
    );
  });

  it("uses an absolute captured URI when it contains a non-default port", () => {
    expect(
      requestLine(
        detail({
          uri: "http://localhost:4317/v1/traces",
          scheme: "http",
          host: "localhost",
          path: "/v1/traces",
        }),
      ),
    ).toBe("GET http://localhost:4317/v1/traces HTTP/1.1");
  });
});

describe("statusLine", () => {
  it("renders version, code, and reason", () => {
    expect(statusLine(detail({ status: 404, respVersion: "HTTP/1.1" }))).toBe(
      "HTTP/1.1 404 Not Found",
    );
  });

  it("omits the reason for an unknown code", () => {
    expect(statusLine(detail({ status: 299 }))).toBe("HTTP/1.1 299");
  });

  it("falls back to HTTP/1.1 when the response version is missing", () => {
    expect(statusLine(detail({ status: 200, respVersion: null }))).toBe("HTTP/1.1 200 OK");
  });

  it("renders just the version when the status is null", () => {
    expect(statusLine(detail({ status: null, respVersion: "HTTP/1.1" }))).toBe("HTTP/1.1");
  });
});

describe("rawMessage", () => {
  it("ends a body-less message on a single blank line", () => {
    expect(
      rawMessage(
        "GET https://example.com/ HTTP/1.1",
        [
          ["Host", "example.com"],
          ["Accept", "*/*"],
        ],
        "",
      ),
    ).toBe("GET https://example.com/ HTTP/1.1\nHost: example.com\nAccept: */*\n\n");
  });

  it("separates the header block from the body with one blank line", () => {
    expect(
      rawMessage("POST https://example.com/ HTTP/1.1", [["Content-Type", "text/plain"]], "hello"),
    ).toBe("POST https://example.com/ HTTP/1.1\nContent-Type: text/plain\n\nhello");
  });

  it("handles a message with no headers", () => {
    expect(rawMessage("HTTP/1.1 204 No Content", [], "")).toBe("HTTP/1.1 204 No Content\n\n");
    expect(rawMessage("HTTP/1.1 200 OK", [], "body")).toBe("HTTP/1.1 200 OK\n\nbody");
  });
});
