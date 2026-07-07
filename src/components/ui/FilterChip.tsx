import type { ButtonHTMLAttributes, ReactNode } from "react";

interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Toggled-on look (teal border + text, or a status tint when `status` is set). */
  on?: boolean;
  /** HTTP status band ("2xx"…"5xx", "pending") — tints the on-state via `s-<status>`. */
  status?: string;
}

/** A compact quick-filter chip (kind / status toggles in the filter bar and
 *  saved-filter editor). Renders the shared `.fchip` design-system classes. */
export function FilterChip({
  on = false,
  status,
  className,
  type = "button",
  children,
  ...rest
}: FilterChipProps) {
  const classes = ["fchip"];
  if (status) classes.push(`s-${status}`);
  if (on) classes.push("on");
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(" ")} {...rest}>
      {children as ReactNode}
    </button>
  );
}
