import { useRef, useState, type ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** Show the tooltip below the trigger instead of above (for items near the top). */
  below?: boolean;
}

/**
 * A lightweight hover tooltip. Uses `position: fixed` computed from the
 * trigger's bounding rect on hover, so it isn't clipped by `overflow: auto`
 * containers (e.g. `.rule-editor`). Position is set once on mouse enter — no
 * re-measurement loop — and cleared on mouse leave.
 */
export function Tooltip({ label, children, below = false }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  return (
    <span
      ref={ref}
      className="tooltip-trigger"
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) {
          setPos({ left: r.left + r.width / 2, top: below ? r.bottom + 6 : r.top - 6 });
        }
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <span className="tooltip-popup" style={{ left: pos.left, top: pos.top }} role="tooltip">
          {label}
        </span>
      )}
    </span>
  );
}
