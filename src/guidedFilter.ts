export type GuidedFilterSide = "both" | "request" | "response";
export type GuidedFilterPart = "content" | "headers" | "bodies";

const PREFIX: Record<GuidedFilterPart, Record<GuidedFilterSide, string>> = {
  content: { both: "content", request: "req-content", response: "resp-content" },
  headers: { both: "header", request: "req-header", response: "resp-header" },
  bodies: { both: "body", request: "req-body", response: "resp-body" },
};

/** Always quote a guided literal so slashes, leading dashes, whitespace, and
 * colons cannot become manual syntax. The parser understands these two JSON-
 * style escapes inside quotes. */
export function quoteFilterLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function guidedFilterTerm(
  value: string,
  side: GuidedFilterSide,
  part: GuidedFilterPart,
): string {
  const literal = value.trim();
  return literal ? `${PREFIX[part][side]}:${quoteFilterLiteral(literal)}` : "";
}

/** Manual text remains a separate source of truth. Changing any guided control
 * replaces this one derived term instead of parsing/re-writing manual syntax. */
export function effectiveFilterQuery(
  manualQuery: string,
  value: string,
  side: GuidedFilterSide,
  part: GuidedFilterPart,
): string {
  return [manualQuery.trim(), guidedFilterTerm(value, side, part)].filter(Boolean).join(" ");
}
