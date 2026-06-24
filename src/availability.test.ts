import { describe, expect, it } from "vitest";
import { availabilityLabel } from "./availability";
import type { Availability } from "./types";

function av(over: Partial<Availability>): Availability {
  return { verdict: "unknown", status: null, location: null, ...over };
}

describe("availabilityLabel", () => {
  it("labels a 2xx re-check as reachable", () => {
    const l = availabilityLabel(av({ verdict: "public", status: 200 }));
    expect(l.text).toBe("Reachable");
    expect(l.tone).toBe("reachable");
    expect(l.title).toContain("open it live");
  });

  it("distinguishes a login redirect from an outright block", () => {
    const redirect = availabilityLabel(
      av({ verdict: "protected", status: 302, location: "/login" }),
    );
    expect(redirect.text).toBe("Login");
    expect(redirect.tone).toBe("login");
    expect(redirect.title).toContain("/login");

    const forbidden = availabilityLabel(av({ verdict: "protected", status: 403 }));
    expect(forbidden.text).toBe("Forbidden");
    expect(forbidden.tone).toBe("forbidden");
  });

  it("labels not-found and network errors", () => {
    expect(availabilityLabel(av({ verdict: "notFound", status: 404 })).text).toBe("Gone");
    const err = availabilityLabel(av({ verdict: "error", status: null }));
    expect(err.text).toBe("Unreachable");
    expect(err.tone).toBe("error");
    expect(err.title).toContain("replay the session");
  });
});
