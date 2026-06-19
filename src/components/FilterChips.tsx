import type { ResourceKind } from "../types";
import { KIND_CHIPS, rawSegments, STATUS_CHIPS } from "../filter";

interface Props {
  typeChips: Set<ResourceKind>;
  statusChips: Set<string>;
  onToggleType: (k: ResourceKind) => void;
  onToggleStatus: (c: string) => void;
  onClearAll: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
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
  filter,
  onFilterChange,
  searching,
  matchCount,
  total,
}: Props) {
  const active = matchCount !== null;
  const segments = filter.trim() ? rawSegments(filter) : [];

  function removeSegment(idx: number) {
    onFilterChange(segments.filter((_, j) => j !== idx).join(" "));
  }

  return (
    <>
      {segments.length > 0 && (
        <div className="filter-pills">
          <span className="pills-label">terms</span>
          {segments.map((seg, i) => (
            <button
              key={`${seg}-${i}`}
              className="filter-pill"
              title="Remove this term"
              onClick={() => removeSegment(i)}
            >
              <span className="pill-text">{seg}</span>
              <span className="pill-x">✕</span>
            </button>
          ))}
        </div>
      )}
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
    </>
  );
}
