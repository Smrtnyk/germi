import { useState } from "react";

import { xor } from "es-toolkit";

import { KIND_CHIPS, STATUS_CHIPS } from "../filter";
import { hasContentTerms, savedFilterLabel, type SavedFilter } from "../savedFilters";
import { IconChevronDown, IconChevronRight, IconClose } from "./icons";
import { Button } from "./ui/Button";
import { FilterChip } from "./ui/FilterChip";

export interface FiltersPanelProps {
  filters: SavedFilter[];
  soloId: string | null;
  /** Live matching-row count per filter id; null = not countable (content terms). */
  counts: Map<string, number | null>;
  /** Whether the filter bar / chips currently hold anything worth saving. */
  canSaveCurrent: boolean;
  onSaveCurrent: () => void;
  onUpdate: (id: string, patch: Partial<Omit<SavedFilter, "id">>) => void;
  onRemove: (id: string) => void;
  onSolo: (id: string | null) => void;
}

function CountBadge({ count }: { count: number | null }) {
  return (
    <span
      className="sf-count"
      title={
        count === null
          ? "No live count — body:/header: terms need a backend scan"
          : `${count} matching request(s)`
      }
    >
      {count ?? "–"}
    </span>
  );
}

function SavedFilterEditor({
  f,
  onUpdate,
}: {
  f: SavedFilter;
  onUpdate: FiltersPanelProps["onUpdate"];
}) {
  return (
    <div className="sf-editor">
      <input
        className="sf-query"
        value={f.query}
        placeholder="host: path: status:4xx body:… — empty matches everything"
        aria-label="Filter query"
        onChange={(e) => onUpdate(f.id, { query: e.target.value })}
      />
      <div className="sf-chips">
        {KIND_CHIPS.map(({ kind, label }) => (
          <FilterChip
            key={kind}
            on={f.kinds.includes(kind)}
            onClick={() => onUpdate(f.id, { kinds: xor(f.kinds, [kind]) })}
          >
            {label}
          </FilterChip>
        ))}
      </div>
      <div className="sf-chips">
        {STATUS_CHIPS.map((c) => (
          <FilterChip
            key={c}
            status={c}
            on={f.statuses.includes(c)}
            onClick={() => onUpdate(f.id, { statuses: xor(f.statuses, [c]) })}
          >
            {c}
          </FilterChip>
        ))}
      </div>
      {hasContentTerms(f.query) && (
        <p className="sf-note">
          body:/header: terms are honored by <strong>only</strong> (full scan) — row highlights skip
          them.
        </p>
      )}
    </div>
  );
}

/** The highlight toggle, disabled for filters the frontend can't evaluate live
 *  (body:/header: terms need a backend scan) so a lit-but-inert toggle never
 *  suggests tinting that will not happen. */
function HighlightToggle({
  f,
  onUpdate,
}: {
  f: SavedFilter;
  onUpdate: FiltersPanelProps["onUpdate"];
}) {
  const highlightable = !hasContentTerms(f.query);
  return (
    <button
      className={`sf-toggle ${f.highlight && highlightable ? "on" : ""}`}
      disabled={!highlightable}
      onClick={() => onUpdate(f.id, { highlight: !f.highlight })}
      title={
        highlightable
          ? "Tint matching rows with this filter's color"
          : "Highlights skip body:/header: filters — use only to apply them via a full scan"
      }
    >
      highlight
    </button>
  );
}

function SavedFilterRow({
  f,
  solo,
  count,
  expanded,
  onToggleExpand,
  onUpdate,
  onRemove,
  onSolo,
}: {
  f: SavedFilter;
  solo: boolean;
  count: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: FiltersPanelProps["onUpdate"];
  onRemove: FiltersPanelProps["onRemove"];
  onSolo: FiltersPanelProps["onSolo"];
}) {
  const label = savedFilterLabel(f);
  return (
    <div className={`sf-item ${expanded ? "expanded" : ""}`}>
      <div className="sf-row">
        <input
          type="color"
          className="sf-color"
          value={f.color}
          aria-label="Highlight color"
          title="Highlight color — matching rows are tinted with it"
          onChange={(e) => onUpdate(f.id, { color: e.target.value })}
        />
        <button
          className="sf-label"
          onClick={onToggleExpand}
          title={expanded ? "Collapse the editor" : "Edit this filter"}
        >
          {expanded ? <IconChevronDown /> : <IconChevronRight />}
          <span className="sf-label-text">{label}</span>
        </button>
        <CountBadge count={count} />
        <button
          className={`sf-toggle ${solo ? "on" : ""}`}
          onClick={() => onSolo(solo ? null : f.id)}
          title="Show only this filter's requests — one saved filter at a time"
        >
          only
        </button>
        <HighlightToggle f={f} onUpdate={onUpdate} />
        <button
          className="sf-remove"
          onClick={() => onRemove(f.id)}
          title="Remove this saved filter"
          aria-label={`Remove filter ${label}`}
        >
          <IconClose />
        </button>
      </div>
      {expanded && <SavedFilterEditor f={f} onUpdate={onUpdate} />}
    </div>
  );
}

export function FiltersPanel({
  filters,
  soloId,
  counts,
  canSaveCurrent,
  onSaveCurrent,
  onUpdate,
  onRemove,
  onSolo,
}: FiltersPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="filters-panel">
      <div className="filters-head">
        <span className="filters-title">Saved filters</span>
        <div className="spacer" />
        <Button
          variant="primary"
          size="small"
          disabled={!canSaveCurrent}
          onClick={onSaveCurrent}
          title={
            canSaveCurrent
              ? "Store the current filter bar + chips as a colored filter"
              : "Type a filter or toggle some chips first"
          }
        >
          + Save current filter
        </Button>
      </div>
      {filters.length === 0 ? (
        <div className="filters-empty">
          <p>
            Saved filters keep a filter query <em>plus</em> its kind/status chips under a color of
            your choice.
          </p>
          <p>
            Matching requests are tinted with that color; <strong>only</strong> narrows the list to
            a single filter's matches. Type a filter above, then save it here.
          </p>
        </div>
      ) : (
        <div className="filters-list">
          {filters.map((f) => (
            <SavedFilterRow
              key={f.id}
              f={f}
              solo={soloId === f.id}
              count={counts.get(f.id) ?? null}
              expanded={expandedId === f.id}
              onToggleExpand={() => setExpandedId((cur) => (cur === f.id ? null : f.id))}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onSolo={onSolo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
