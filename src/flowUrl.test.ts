import { describe, expect, it } from "vitest";

import { flowUrl } from "./flowUrl";

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
