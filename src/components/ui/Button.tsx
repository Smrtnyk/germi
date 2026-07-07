import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "default" | "primary" | "ghost";
type ButtonSize = "default" | "small";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Selected / toggled-on look (teal border + text). */
  active?: boolean;
  /** Destructive tint; combines with any variant (e.g. a ghost danger button). */
  danger?: boolean;
  /** Stretch to the full width of the container. */
  block?: boolean;
}

/** The one button primitive. Renders the shared `.btn` design-system classes so
 *  every button across the app looks and presses the same. Context-specific
 *  hooks (positioning, one-off tweaks) still ride along via `className`. */
export function Button({
  variant = "default",
  size = "default",
  active = false,
  danger = false,
  block = false,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn"];
  if (variant === "primary") classes.push("primary");
  if (variant === "ghost") classes.push("ghost");
  if (danger) classes.push("danger");
  if (active) classes.push("active");
  if (size === "small") classes.push("small");
  if (block) classes.push("block");
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(" ")} {...rest}>
      {children as ReactNode}
    </button>
  );
}
