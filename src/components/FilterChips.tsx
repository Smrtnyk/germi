import type { AvailabilityProgress, ResourceKind } from "../types";
import { KIND_CHIPS, rawSegments, STATUS_CHIPS } from "../filter";
import type { FilterViewMode } from "../savedFilters";
import { IconClose } from "./icons";
import { FilterChip } from "./ui/FilterChip";
import { SegmentedControl } from "./ui/SegmentedControl";

/** The issue-90 view controls riding the chips row: the hide/dim switch, the
 *  save-filter action, and the solo'd ("only") saved filter, if any. */
export interface FilterViewControls {
  /** What happens to non-matching rows: removed from the list or dimmed. */
  mode: FilterViewMode;
  onMode: (mode: FilterViewMode) => void;
  /** Human label of the hide/dim shortcut, for the switch tooltip. */
  accel: string;
  /** Whether the bar/chips hold anything — gates the hide/dim switch (which
   *  only affects bar narrowing; "only" narrows regardless) and save-filter. */
  barActive: boolean;
  onSave: () => void;
  /** The solo'd saved filter narrowing the list, or null. */
  solo: { label: string; color: string } | null;
  onClearSolo: () => void;
}

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
  view: FilterViewControls;
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
    <FilterChip
      className="delete-captured"
      onClick={onDelete}
      title="Remove every live-captured request, keeping the imported ones (undo with Ctrl/⌘ Z)"
    >
      Delete captured ({capturedCount})
    </FilterChip>
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
    <FilterChip
      className="availability-check"
      onClick={onCheck}
      disabled={progress !== null}
      title="Re-issue the selected or filtered requests (or all unchecked doc requests) without your cookies/auth to test whether they are publicly reachable"
    >
      {progress ? `Checking ${progress.completed}/${progress.total}…` : "Check availability"}
    </FilterChip>
  );
}

/** The Hide/Dim switch (issue #90): whether non-matching rows leave the list
 *  entirely (Fiddler-style, the default) or stay visible but dimmed. */
function ViewModeSwitch({ view }: { view: FilterViewControls }) {
  return (
    <SegmentedControl
      className="filter-mode"
      ariaLabel="Non-matching requests"
      options={[
        {
          value: "hide",
          label: "Hide",
          title: `Remove non-matching requests from the list (${view.accel} toggles)`,
        },
        {
          value: "dim",
          label: "Dim",
          title: `Keep non-matching requests visible but dimmed (${view.accel} toggles)`,
        },
      ]}
      value={view.mode}
      onChange={view.onMode}
    />
  );
}

/** The "only: …" chip shown while a saved filter is solo'd — the affordance
 *  that explains why the list is narrowed even with an empty filter bar. */
function SoloChip({
  solo,
  onClear,
}: {
  solo: { label: string; color: string };
  onClear: () => void;
}) {
  return (
    <FilterChip
      className="solo-chip"
      on
      onClick={onClear}
      title={`Showing only requests matching "${solo.label}" — click to show everything`}
    >
      <span className="solo-dot" style={{ background: solo.color }} />
      only: <span className="solo-label">{solo.label}</span>
      <IconClose />
    </FilterChip>
  );
}

/** The trailing status cluster: the live "searching…" hint, the `N of M` match
 *  count, the hide/dim switch, save-filter, and the clear-filters button (all
 *  but the hint only with a filter active). */
function FilterStatus({
  searching,
  matchCount,
  total,
  onClearAll,
  view,
}: {
  searching: boolean;
  matchCount: number | null;
  total: number;
  onClearAll: () => void;
  view: FilterViewControls;
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
      {view.barActive && <ViewModeSwitch view={view} />}
      {view.barActive && (
        <FilterChip
          className="save-filter"
          onClick={view.onSave}
          title="Store this filter + chips in the Filters tab under a color; matching rows get tinted"
        >
          + Save filter
        </FilterChip>
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
  view,
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
          <FilterChip key={kind} on={typeChips.has(kind)} onClick={() => onToggleType(kind)}>
            {label}
          </FilterChip>
        ))}
        <span className="fchip-sep" />
        {STATUS_CHIPS.map((c) => (
          <FilterChip key={c} status={c} on={statusChips.has(c)} onClick={() => onToggleStatus(c)}>
            {c}
          </FilterChip>
        ))}
        {view.solo && <SoloChip solo={view.solo} onClear={view.onClearSolo} />}
        <AvailabilityCheckButton onCheck={onCheckAvailability} progress={availabilityCheck} />
        <DeleteCapturedButton {...capturedDelete} />
        <FilterStatus
          searching={searching}
          matchCount={matchCount}
          total={total}
          onClearAll={onClearAll}
          view={view}
        />
      </div>
    </>
  );
}
