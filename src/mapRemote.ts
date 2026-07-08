import type { Matcher } from "./types";

/**
 * Numeric capture references in a Map Remote target template — `$1` and `${1}`
 * forms, with `$$` escapes skipped. Named references (`$name` / `${name}`) are
 * ignored: group names can't start with a digit, so they never collide.
 */
export function numericCaptureRefs(template: string): number[] {
  const refs: number[] = [];
  for (const m of template.matchAll(/\$(\$)|\$\{(\d+)\}|\$(\d+)/g)) {
    const n = m[2] ?? m[3];
    if (!m[1] && n !== undefined) refs.push(Number(n));
  }
  return refs;
}

/**
 * Count the capture groups in a Rust-dialect regex pattern (named groups
 * normalized to JS syntax first). Null when the pattern doesn't compile as a
 * JS regex — the matcher's own warning already covers that case.
 */
export function regexGroupCount(pattern: string): number | null {
  try {
    const match = new RegExp(`${pattern.replace(/\(\?P</g, "(?<")}|`).exec("");
    return match ? match.length - 1 : null;
  } catch {
    return null;
  }
}

/**
 * Non-blocking lints for a Map Remote action, mirroring the engine's skip
 * rules (`map_remote_target` in rules.rs): flag targets the engine would
 * silently skip and capture references that can't expand.
 */
export function mapRemoteWarnings(matcher: Matcher, url: string): string[] {
  const target = url.trim();
  if (!target) {
    return ["Target URL is empty — this rule will be skipped."];
  }
  const warnings: string[] = [];
  // A target may legitimately start with a capture reference (e.g. a captured
  // scheme), so only flag a literal non-http(s) prefix.
  if (!/^https?:\/\//i.test(target) && !target.startsWith("$")) {
    warnings.push(
      "Target must be an absolute http(s):// URL — this rule will be skipped at request time.",
    );
  }
  const refs = numericCaptureRefs(target);
  if (refs.length === 0) return warnings;
  if (matcher.urlMatch !== "regex") {
    warnings.push(
      "Capture references ($1…) only expand with a Regex matcher — they'll be forwarded literally.",
    );
    return warnings;
  }
  const groups = regexGroupCount(matcher.url);
  const highest = Math.max(...refs);
  if (groups !== null && highest > groups) {
    warnings.push(
      `The target references $${highest} but the URL pattern only has ${groups} capture group${
        groups === 1 ? "" : "s"
      } — missing groups expand to nothing.`,
    );
  }
  return warnings;
}
