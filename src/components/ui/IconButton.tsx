import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name — required because the button shows only an icon. Also the
   *  default tooltip when `title` is omitted. */
  label: string;
  /** Red hover for destructive actions (remove / delete / dismiss). */
  danger?: boolean;
}

/** A bare, icon-only button (close ×, list remove, clear). Renders the shared
 *  `.icon-btn` design-system class so every icon affordance hovers and presses
 *  the same; positioning still rides along via `className`. */
export function IconButton({
  label,
  danger = false,
  className,
  title,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  const classes = ["icon-btn"];
  if (danger) classes.push("danger");
  if (className) classes.push(className);

  return (
    <button
      type={type}
      className={classes.join(" ")}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      {children as ReactNode}
    </button>
  );
}
