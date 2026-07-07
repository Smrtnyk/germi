import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Toggled-on look (teal border + text). */
  on?: boolean;
}

/** A small, toggleable pill (status presets, quick filters). Renders the shared
 *  `.chip` design-system classes; the selected state carries `.on`. */
export function Chip({ on = false, className, type = "button", children, ...rest }: ChipProps) {
  const classes = ["chip"];
  if (on) classes.push("on");
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(" ")} {...rest}>
      {children as ReactNode}
    </button>
  );
}
