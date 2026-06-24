import type { Availability } from "./types";

// Turn a raw availability verdict into the worded label, color tone, and tooltip
// shown in the traffic row and the Inspector. The framing is the user's actual
// decision: can WE open this URL live in a browser (without the customer's
// session), or must we replay their captured session?

export type AvailabilityTone = "reachable" | "login" | "forbidden" | "gone" | "error" | "unknown";

export interface AvailabilityLabel {
  /** Worded verdict for the Inspector (e.g. "Reachable", "Login", "Forbidden"). */
  text: string;
  /** Compact glyph for the inline row marker. */
  icon: string;
  /** Drives the color (shared by the row icon and the Inspector badge). */
  tone: AvailabilityTone;
  /** Full explanation for the hover tooltip / Inspector. */
  title: string;
}

const TONE_ICON: Record<AvailabilityTone, string> = {
  reachable: "✓",
  login: "→",
  forbidden: "✕",
  gone: "∅",
  error: "⚠",
  unknown: "?",
};

function isRedirect(status: number | null): boolean {
  return status != null && status >= 300 && status < 400;
}

function label(text: string, tone: AvailabilityTone, title: string): AvailabilityLabel {
  return { text, tone, title, icon: TONE_ICON[tone] };
}

export function availabilityLabel(a: Availability): AvailabilityLabel {
  const code = a.status != null ? `HTTP ${a.status}` : "no response";
  switch (a.verdict) {
    case "public":
      return label(
        "Reachable",
        "reachable",
        `Reachable without credentials (${code}) — you can open it live in a browser.`,
      );
    case "protected":
      if (isRedirect(a.status)) {
        const to = a.location ? ` → ${a.location}` : "";
        return label(
          "Login",
          "login",
          `Redirects without credentials (${code}${to}) — needs the customer's login; replay the session.`,
        );
      }
      return label(
        "Forbidden",
        "forbidden",
        `Blocked without credentials (${code}) — needs the customer's login; replay the session.`,
      );
    case "notFound":
      return label("Gone", "gone", `Not found without credentials (${code}).`);
    case "error":
      return label(
        "Unreachable",
        "error",
        "Couldn't reach it (network error or timeout) — replay the session.",
      );
    default:
      return label("Unclear", "unknown", `Inconclusive re-check (${code}).`);
  }
}
