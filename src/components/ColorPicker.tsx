import { useId, useRef, useState, type DragEvent as ReactDragEvent } from "react";

import { joinHex8, parseHexEntry, type ColorParts } from "../theme";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export interface ColorPickerProps {
  label: string;
  value: ColorParts;
  /** The exact applied CSS color painted over the shared `--bg` underlay. */
  swatchBackground: string;
  dataKey?: string;
  draggable?: boolean;
  dragTitle?: string;
  onDragStart?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  /** Live draft updates. Callers may preview without persisting. */
  onPreview?: (value: ColorParts) => void;
  /** One normalized value after explicit Apply. */
  onCommit: (value: ColorParts) => void;
  /** Escape or explicit Cancel. */
  onCancel?: () => void;
}

interface DialogProps extends Pick<
  ColorPickerProps,
  "label" | "value" | "onPreview" | "onCommit" | "onCancel"
> {
  onDismiss: () => void;
}

function ColorPickerDialog({
  label,
  value,
  onPreview,
  onCommit,
  onCancel,
  onDismiss,
}: DialogProps) {
  const titleId = useId();
  const hueId = useId();
  const hexId = useId();
  const opacityId = useId();
  const errorId = useId();
  const outcomeRef = useRef<ColorParts | null>(null);
  const [draft, setDraft] = useState(value);
  const [hexDraft, setHexDraft] = useState(() => joinHex8(value));
  const parsedDraft = parseHexEntry(hexDraft, draft.alphaPct);

  function preview(next: ColorParts, syncHex = true) {
    setDraft(next);
    if (syncHex) setHexDraft(joinHex8(next));
    onPreview?.(next);
  }

  function editHex(text: string) {
    setHexDraft(text);
    const parsed = parseHexEntry(text, draft.alphaPct);
    if (parsed) preview(parsed, false);
  }

  function closeDialog() {
    const committed = outcomeRef.current;
    if (committed) onCommit(committed);
    else onCancel?.();
    onDismiss();
  }

  return (
    <Modal className="color-picker-modal" ariaLabelledby={titleId} onClose={closeDialog}>
      {(close) => (
        <>
          <h3 id={titleId}>{label} color</h3>
          <span className="color-picker-dialog-preview" aria-hidden="true">
            <span style={{ background: joinHex8(draft) }} />
          </span>
          <div className="color-picker-fields">
            <label htmlFor={hueId}>Color</label>
            <input
              id={hueId}
              type="color"
              value={draft.hex}
              aria-label={`${label} hue`}
              autoFocus
              onChange={(event) => preview({ ...draft, hex: event.target.value })}
            />
            <label htmlFor={hexId}>Hex</label>
            <div className="color-picker-hex-wrap">
              <input
                id={hexId}
                className="color-picker-hex"
                value={hexDraft}
                spellCheck={false}
                aria-invalid={parsedDraft === null}
                aria-describedby={parsedDraft === null ? errorId : undefined}
                onChange={(event) => editHex(event.target.value)}
              />
              {parsedDraft === null && (
                <span id={errorId} className="color-picker-error" role="alert">
                  Use 6- or 8-digit hex.
                </span>
              )}
            </div>
            <label htmlFor={opacityId}>Opacity</label>
            <div className="color-picker-opacity">
              <input
                id={opacityId}
                type="range"
                min={0}
                max={100}
                step={1}
                value={draft.alphaPct}
                aria-label={`${label} opacity`}
                onChange={(event) => preview({ ...draft, alphaPct: Number(event.target.value) })}
              />
              <output htmlFor={opacityId}>{draft.alphaPct}%</output>
            </div>
          </div>
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={parsedDraft === null}
              onClick={() => {
                if (!parsedDraft) return;
                outcomeRef.current = parsedDraft;
                close();
              }}
            >
              Apply
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Shared color + opacity interaction for every configurable color surface. */
export function ColorPicker({
  label,
  value,
  swatchBackground,
  dataKey,
  draggable,
  dragTitle,
  onDragStart,
  onPreview,
  onCommit,
  onCancel,
}: ColorPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="color-picker" data-color-key={dataKey}>
      <button
        type="button"
        className="color-picker-trigger"
        aria-label={`${label} color`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={dragTitle ?? `Edit ${label} color and opacity`}
        draggable={draggable}
        onDragStart={onDragStart}
        onClick={() => setOpen(true)}
      >
        <span className="color-picker-swatch" aria-hidden="true">
          <span className="color-picker-swatch-tint" style={{ background: swatchBackground }} />
        </span>
      </button>
      {open && (
        <ColorPickerDialog
          label={label}
          value={value}
          onPreview={onPreview}
          onCommit={onCommit}
          onCancel={onCancel}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
}
