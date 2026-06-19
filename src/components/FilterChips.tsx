import type { ResourceKind } from "../types";
import { KIND_CHIPS, STATUS_CHIPS } from "../filter";

interface Props {
  typeChips: Set<ResourceKind>;
  statusChips: Set<string>;
  onToggleType: (k: ResourceKind) => void;
  onToggleStatus: (c: string) => void;
  onClearAll: () => void;
  searching: boolean;
  /** Number of matching rows, or null when no filter is active. */
  matchCount: number | null;
  total: number;
}

export function FilterChips({
  typeChips,
  statusChips,
  onToggleType,
  onToggleStatus,
  onClearAll,
  searching,
  matchCount,
  total,
}: Props) {
  const active = matchCount !== null;
  return (
    <div className="filter-chips">
      {KIND_CHIPS.map(({ kind, label }) => (
        <button
          key={kind}
          className={`fchip ${typeChips.has(kind) ? "on" : ""}`}
          onClick={() => onToggleType(kind)}
        >
          {label}
        </button>
      ))}
      <span className="fchip-sep" />
      {STATUS_CHIPS.map((c) => (
        <button
          key={c}
          className={`fchip s-${c} ${statusChips.has(c) ? "on" : ""}`}
          onClick={() => onToggleStatus(c)}
        >
          {c}
        </button>
      ))}
      <div className="filter-status">
        {searching && <span className="searching">searching…</span>}
        {active && (
          <span className={`match-count ${matchCount === 0 ? "zero" : ""}`}>
            {matchCount === 0 ? (
              <>no matches of {total}</>
            ) : (
              <>
                <strong>{matchCount}</strong> of {total} match
              </>
            )}
          </span>
        )}
        {active && (
          <button className="chips-clear" onClick={onClearAll} title="Clear all filters">
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
