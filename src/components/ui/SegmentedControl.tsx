import type { ReactNode } from "react";

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Labels the group for assistive tech and renders `role="group"`. */
  ariaLabel?: string;
  /** Extra class on the `.seg` wrapper for context-specific sizing/placement. */
  className?: string;
}

/** A one-of-N segmented switch (Parsed/Raw, Split/Unified, Hide/Dim, …). Renders
 *  the shared `.seg` design-system classes; the active option carries `.on`. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={className ? `seg ${className}` : "seg"}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? "on" : ""}
          title={opt.title}
          disabled={opt.disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
