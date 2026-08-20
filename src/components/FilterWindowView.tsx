import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import { xor } from "es-toolkit";

import { KIND_CHIPS, STATUS_CHIPS } from "../filter";
import {
  effectiveFilterQuery,
  type GuidedFilterPart,
  type GuidedFilterSide,
} from "../guidedFilter";
import type { FilterSaveResult } from "../filterWindowProtocol";
import {
  prepareFilterDraft,
  savedFilterLabel,
  type FilterDraft,
  type SavedFilter,
} from "../savedFilters";
import type { ColorParts } from "../theme";
import { ColorPicker } from "./ColorPicker";
import { FilterHelp } from "./FilterHelp";
import { Button } from "./ui/Button";
import { FilterChip } from "./ui/FilterChip";

interface Props {
  draft: FilterDraft;
  existingFilters: SavedFilter[];
  colorPresets: readonly ColorParts[];
  windowError: string | null;
  onChange: (draft: FilterDraft) => void;
  onPreviewChange: (draft: FilterDraft, only: boolean) => void;
  onSave: (draft: FilterDraft, only: boolean) => Promise<FilterSaveResult>;
  onSavingChange: (saving: boolean) => void;
  onCancel: () => void;
}

type UpdateDraft = (patch: Partial<FilterDraft>) => void;

function GuidedSearch({
  value,
  side,
  part,
  effectiveQuery,
  onValue,
  onSide,
  onPart,
}: {
  value: string;
  side: GuidedFilterSide;
  part: GuidedFilterPart;
  effectiveQuery: string;
  onValue: (value: string) => void;
  onSide: (side: GuidedFilterSide) => void;
  onPart: (part: GuidedFilterPart) => void;
}) {
  const guidedId = useId();
  const sideId = useId();
  const partId = useId();
  const effectiveId = useId();
  return (
    <fieldset className="filter-dialog-group filter-guided-search">
      <legend>Guided content search</legend>
      <div className="filter-guided-controls">
        <label className="filter-guided-value" htmlFor={guidedId}>
          Search text
          <input
            id={guidedId}
            type="search"
            value={value}
            autoComplete="off"
            placeholder="token or phrase"
            onChange={(event) => onValue(event.target.value)}
          />
        </label>
        <label htmlFor={sideId}>
          Side
          <select
            id={sideId}
            value={side}
            onChange={(event) => onSide(event.target.value as GuidedFilterSide)}
          >
            <option value="both">Both</option>
            <option value="request">Request</option>
            <option value="response">Response</option>
          </select>
        </label>
        <label htmlFor={partId}>
          Part
          <select
            id={partId}
            value={part}
            onChange={(event) => onPart(event.target.value as GuidedFilterPart)}
          >
            <option value="content">Headers + bodies</option>
            <option value="headers">Headers</option>
            <option value="bodies">Bodies</option>
          </select>
        </label>
      </div>
      <div className="filter-effective-query">
        <span id={effectiveId}>Effective query</span>
        <output htmlFor={`${guidedId} ${sideId} ${partId}`} aria-labelledby={effectiveId}>
          {effectiveQuery || "(chips only)"}
        </output>
      </div>
    </fieldset>
  );
}

function FilterDraftFields({
  draft,
  effectiveQuery,
  guideValue,
  guideSide,
  guidePart,
  only,
  color,
  colorPresets,
  update,
  onGuideValue,
  onGuideSide,
  onGuidePart,
  onOnly,
  onColorPreview,
  onColorCancel,
  onColorCommit,
  queryRef,
}: {
  draft: FilterDraft;
  effectiveQuery: string;
  guideValue: string;
  guideSide: GuidedFilterSide;
  guidePart: GuidedFilterPart;
  only: boolean;
  color: ColorParts;
  colorPresets: readonly ColorParts[];
  update: UpdateDraft;
  onGuideValue: (value: string) => void;
  onGuideSide: (side: GuidedFilterSide) => void;
  onGuidePart: (part: GuidedFilterPart) => void;
  onOnly: (only: boolean) => void;
  onColorPreview: (value: ColorParts) => void;
  onColorCancel: () => void;
  onColorCommit: (value: ColorParts) => void;
  queryRef: RefObject<HTMLInputElement | null>;
}) {
  const hintId = useId();
  const modeHintId = useId();
  const name = savedFilterLabel({ ...draft, query: effectiveQuery });
  return (
    <>
      <div className="filter-window-label-row">
        <label className="filter-dialog-label" htmlFor="filter-window-query">
          Manual query
        </label>
        <FilterHelp
          filter={draft.query}
          onPick={(query) => update({ query })}
          inputRef={queryRef}
        />
      </div>
      <p className="muted small filter-dialog-hint" id={hintId}>
        Manual syntax uses the same matching behavior as the main filter bar.
      </p>
      <input
        ref={queryRef}
        id="filter-window-query"
        name="query"
        className="filter-dialog-query"
        value={draft.query}
        aria-describedby={hintId}
        autoComplete="off"
        placeholder="host:api.example.com status:4xx"
        onChange={(event) => update({ query: event.target.value })}
      />

      <GuidedSearch
        value={guideValue}
        side={guideSide}
        part={guidePart}
        effectiveQuery={effectiveQuery}
        onValue={onGuideValue}
        onSide={onGuideSide}
        onPart={onGuidePart}
      />

      <fieldset className="filter-dialog-group">
        <legend>Resource types</legend>
        <div className="filter-dialog-chips">
          {KIND_CHIPS.map(({ kind, label }) => (
            <FilterChip
              key={kind}
              on={draft.kinds.includes(kind)}
              aria-pressed={draft.kinds.includes(kind)}
              onClick={() => update({ kinds: xor(draft.kinds, [kind]) })}
            >
              {label}
            </FilterChip>
          ))}
        </div>
      </fieldset>

      <fieldset className="filter-dialog-group">
        <legend>Response status</legend>
        <div className="filter-dialog-chips">
          {STATUS_CHIPS.map((status) => (
            <FilterChip
              key={status}
              status={status}
              on={draft.statuses.includes(status)}
              aria-pressed={draft.statuses.includes(status)}
              onClick={() => update({ statuses: xor(draft.statuses, [status]) })}
            >
              {status}
            </FilterChip>
          ))}
        </div>
      </fieldset>

      <div className="filter-dialog-options" aria-describedby={modeHintId}>
        <div className="filter-dialog-color">
          <span>Highlight color</span>
          <ColorPicker
            label="Highlight"
            value={color}
            swatchBackground={`color-mix(in srgb, ${color.hex} ${color.alphaPct}%, transparent)`}
            presets={colorPresets}
            onPreview={onColorPreview}
            onCancel={onColorCancel}
            onCommit={onColorCommit}
          />
        </div>
        <div className="filter-dialog-mode-pills">
          <FilterChip
            on={draft.highlight}
            aria-pressed={draft.highlight}
            onClick={() => update({ highlight: !draft.highlight })}
          >
            Highlight
          </FilterChip>
          <FilterChip on={only} aria-pressed={only} onClick={() => onOnly(!only)}>
            Only
          </FilterChip>
        </div>
      </div>
      <p className="muted small filter-dialog-mode-hint" id={modeHintId}>
        Preview appears on the real traffic list. Only temporarily narrows that list and, on save,
        activates the new filter alone.
      </p>

      <p className="filter-dialog-name">
        Saved filter name: <strong>{name}</strong>
      </p>
    </>
  );
}

function useFilterWindowForm({
  existingFilters,
  onChange,
  onSave,
  onSavingChange,
  onCancel,
}: Pick<Props, "existingFilters" | "onChange" | "onSave" | "onSavingChange" | "onCancel">) {
  const queryRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    queryRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      if (saving) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);

  function update(draft: FilterDraft, patch: Partial<FilterDraft>) {
    onChange({ ...draft, ...patch });
    setError(null);
  }

  function finishFailure(message: string, filterWasSaved = false) {
    if (!mountedRef.current) return;
    setError(message);
    if (filterWasSaved) setSaved(true);
    setSaving(false);
    onSavingChange(false);
  }

  async function submit(draft: FilterDraft, only: boolean) {
    if (!saved) {
      const prepared = prepareFilterDraft(draft, existingFilters);
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
    }
    setSaving(true);
    onSavingChange(true);
    try {
      const result = await onSave(draft, only);
      if (!result.ok) finishFailure(result.error, result.saved === true);
    } catch (cause) {
      finishFailure(`Could not save the filter: ${String(cause)}`);
    }
  }

  return { queryRef, error, saving, saved, update, submit };
}

function submitLabel(saving: boolean, saved: boolean): string {
  if (saving) return saved ? "Closing…" : "Saving…";
  return saved ? "Retry close" : "Save filter";
}

export function FilterWindowView(props: Props) {
  const { onPreviewChange } = props;
  const form = useFilterWindowForm(props);
  const [guideValue, setGuideValue] = useState("");
  const [guideSide, setGuideSide] = useState<GuidedFilterSide>("both");
  const [guidePart, setGuidePart] = useState<GuidedFilterPart>("content");
  const [only, setOnly] = useState(false);
  const [colorPreview, setColorPreview] = useState<ColorParts | null>(null);
  const color = colorPreview ?? { hex: props.draft.color, alphaPct: props.draft.opacity };
  const effectiveQuery = effectiveFilterQuery(props.draft.query, guideValue, guideSide, guidePart);
  const effectiveDraft = useMemo(
    () => ({
      ...props.draft,
      query: effectiveQuery,
      color: color.hex,
      opacity: color.alphaPct,
    }),
    [props.draft, effectiveQuery, color.hex, color.alphaPct],
  );

  useEffect(() => {
    if (!form.saved) onPreviewChange(effectiveDraft, only);
  }, [effectiveDraft, only, onPreviewChange, form.saved]);

  return (
    <main className="filter-window">
      <form
        className="filter-window-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit(effectiveDraft, only);
        }}
      >
        <header className="filter-window-head">
          <div>
            <h1>Create saved filter</h1>
            <p className="muted small">Build here and preview directly on the traffic list.</p>
          </div>
        </header>
        <fieldset
          className="filter-window-fields"
          aria-label="Filter definition"
          disabled={form.saved}
        >
          <FilterDraftFields
            draft={props.draft}
            effectiveQuery={effectiveQuery}
            guideValue={guideValue}
            guideSide={guideSide}
            guidePart={guidePart}
            only={only}
            color={color}
            colorPresets={props.colorPresets}
            update={(patch) => form.update(props.draft, patch)}
            onGuideValue={setGuideValue}
            onGuideSide={setGuideSide}
            onGuidePart={setGuidePart}
            onOnly={setOnly}
            onColorPreview={setColorPreview}
            onColorCancel={() => setColorPreview(null)}
            onColorCommit={({ hex, alphaPct }) => {
              setColorPreview(null);
              form.update(props.draft, { color: hex, opacity: alphaPct });
            }}
            queryRef={form.queryRef}
          />
        </fieldset>
        {props.windowError && (
          <p className="warn filter-dialog-error" role="alert">
            {props.windowError}
          </p>
        )}
        {form.error && (
          <p className="warn filter-dialog-error" role="alert">
            {form.error}
          </p>
        )}
        <footer className="filter-window-foot">
          <Button onClick={props.onCancel} disabled={form.saving || form.saved}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={form.saving}>
            {submitLabel(form.saving, form.saved)}
          </Button>
        </footer>
      </form>
    </main>
  );
}
