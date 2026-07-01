import type { AvailabilityProgress, ResourceKind } from "../types";
import { KIND_CHIPS, rawSegments, STATUS_CHIPS } from "../filter";
import { IconClose } from "./icons";

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
  /** Run an on-demand public-availability check over the in-scope requests. */
  onCheckAvailability: () => void;
  /** Live progress while a check runs, or null when idle. */
  availabilityCheck: AvailabilityProgress | null;
  /** Imported/captured split + the prune action for the "Delete captured" button. */
  capturedDelete: CapturedDelete;
}

interface CapturedDelete {
  /** How many live-captured (non-imported) flows are present. */
  capturedCount: number;
  /** How many imported (file-loaded) flows are present. */
  importedCount: number;
  /** Prune every live-captured flow, keeping the imported reference (issue #49). */
  onDelete: () => void;
}

/** Appears only while replaying an imported session (some imported AND some
 *  captured flows present) — one click prunes the live-capture noise that piles
 *  up, keeping the imported reference. Undoable. */
function DeleteCapturedButton({ capturedCount, importedCount, onDelete }: CapturedDelete) {
  if (importedCount === 0 || capturedCount === 0) return null;
  return (
    <button
      className="fchip delete-captured"
      onClick={onDelete}
      title="Remove every live-captured request, keeping the imported ones (undo with Ctrl/⌘ Z)"
    >
      Delete captured ({capturedCount})
    </button>
  );
}

function AvailabilityCheckButton({
  onCheck,
  progress,
}: {
  onCheck: () => void;
  progress: AvailabilityProgress | null;
}) {
  return (
    <button
      className="fchip availability-check"
      onClick={onCheck}
      disabled={progress !== null}
      title="Re-issue the selected or filtered requests (or all unchecked doc requests) without your cookies/auth to test whether they are publicly reachable"
    >
      {progress ? `Checking ${progress.completed}/${progress.total}…` : "Check availability"}
    </button>
  );
}

/** The trailing status cluster: the live "searching…" hint, the `N of M` match
 *  count, and the clear-filters button (the last two only with a filter active). */
function FilterStatus({
  searching,
  matchCount,
  total,
  onClearAll,
}: {
  searching: boolean;
  matchCount: number | null;
  total: number;
  onClearAll: () => void;
}) {
  const active = matchCount !== null;
  return (
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
  );
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
  onCheckAvailability,
  availabilityCheck,
  capturedDelete,
}: Props) {
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
              <span className="pill-x">
                <IconClose />
              </span>
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
        <AvailabilityCheckButton onCheck={onCheckAvailability} progress={availabilityCheck} />
        <DeleteCapturedButton {...capturedDelete} />
        <FilterStatus
          searching={searching}
          matchCount={matchCount}
          total={total}
          onClearAll={onClearAll}
        />
      </div>
    </>
  );
}
