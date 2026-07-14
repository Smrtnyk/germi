import { describe, expect, it } from "vitest";

import { flowDetailUrl, flowUrl } from "./flowUrl";
import { detail } from "./flowFixtures";

describe("flowUrl", () => {
  it("joins scheme, host, and path into an absolute URL", () => {
    expect(flowUrl({ scheme: "https", host: "example.com", path: "/users" })).toBe(
      "https://example.com/users",
    );
  });

  it("keeps the port and query string carried in host/path", () => {
    expect(flowUrl({ scheme: "http", host: "api.test:8080", path: "/q?id=1&x=2" })).toBe(
      "http://api.test:8080/q?id=1&x=2",
    );
  });
});

describe("flowDetailUrl", () => {
  it("prefers an absolute captured URI over legacy reconstructed parts", () => {
    expect(
      flowDetailUrl(
        detail({
          uri: "http://localhost:4317/v1/traces?q=1",
          host: "localhost",
          path: "/v1/traces?q=1",
          scheme: "http",
        }),
      ),
    ).toBe("http://localhost:4317/v1/traces?q=1");
  });

  it("falls back for intercepted origin-form URIs", () => {
    expect(flowDetailUrl(detail({ uri: "/api", host: "api.test:8443", path: "/api" }))).toBe(
      "https://api.test:8443/api",
    );
  });
});
