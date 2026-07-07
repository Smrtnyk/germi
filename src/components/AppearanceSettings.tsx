import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
} from "react";
import { isEqual } from "es-toolkit";

import { COLOR_DRAG_MIME, hasColorDrag } from "../dnd";
import {
  applyHighlightColors,
  effectiveColor,
  HIGHLIGHT_COLORS,
  joinHex8,
  parseHexEntry,
  splitHex8,
  withOverride,
  type ColorParts,
  type HighlightColorSpec,
} from "../theme";
import type { ProxySettings } from "../types";
import { Button } from "./ui/Button";

const GROUPS: { id: HighlightColorSpec["group"]; label: string }[] = [
  { id: "rows", label: "Traffic rows" },
  { id: "diff", label: "Compare & diff" },
];

/**
 * Settings → Appearance (issue #93): every highlight tint the app uses, as a
 * swatch + opacity pair. Edits preview live by writing the custom properties
 * directly; the settings save happens once per interaction, on the input's
 * native `change` (picker closed / slider released), not on every drag tick.
 */
export function AppearanceSettings({
  settings,
  onChange,
}: {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}) {
  const colors = settings.highlightColors;

  function commit(spec: HighlightColorSpec, value: string | null) {
    const next = withOverride(colors, spec, value);
    applyHighlightColors(next);
    if (!isEqual(next, colors)) onChange({ ...settings, highlightColors: next });
  }

  function resetAll() {
    applyHighlightColors({});
    onChange({ ...settings, highlightColors: {} });
  }

  const anyOverridden = HIGHLIGHT_COLORS.some((s) => colors[s.key] !== undefined);

  return (
    <div className="settings-pane">
      <h4>Appearance</h4>
      <p className="muted small">
        Highlight tints for the traffic list and the compare window. Most are translucent by design,
        so the opacity slider is part of the color. Changes preview live and follow into every
        window.
      </p>
      {GROUPS.map((g) => (
        <Fragment key={g.id}>
          <div className="col-section-label">{g.label}</div>
          <ul className="color-list">
            {HIGHLIGHT_COLORS.filter((s) => s.group === g.id).map((spec) => (
              <ColorRow
                key={spec.key}
                spec={spec}
                effective={effectiveColor(colors, spec)}
                overridden={colors[spec.key] !== undefined}
                onPreview={(v) => applyHighlightColors({ ...colors, [spec.key]: v })}
                onCommit={(v) => commit(spec, v)}
              />
            ))}
          </ul>
        </Fragment>
      ))}
      <div className="col-add-list">
        <Button size="small" onClick={resetAll} disabled={!anyOverridden}>
          Reset all to defaults
        </Button>
      </div>
    </div>
  );
}

/** React's onChange on color/range inputs fires on every drag tick (`input`);
 *  the native `change` fires once the interaction ends — that's the commit. */
function useCommitOnNativeChange(commitRef: MutableRefObject<() => void>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => commitRef.current();
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, [commitRef]);
  return ref;
}

/** Direct hex entry (issue #93 follow-up): commits on Enter/blur, reverting
 *  to the current value when the text doesn't parse. */
function HexField({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="color-hex"
      value={draft}
      spellCheck={false}
      aria-label={`${label} hex`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onCommit(draft);
        setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ColorRow({
  spec,
  effective,
  overridden,
  onPreview,
  onCommit,
}: {
  spec: HighlightColorSpec;
  effective: string;
  overridden: boolean;
  onPreview: (value: string) => void;
  onCommit: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(() => splitHex8(effective));
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => setDraft(splitHex8(effective)), [effective]);

  const commitRef = useRef(() => {});
  commitRef.current = () => onCommit(joinHex8(draft));
  const colorRef = useCommitOnNativeChange(commitRef);
  const rangeRef = useCommitOnNativeChange(commitRef);

  function update(parts: ColorParts) {
    setDraft(parts);
    onPreview(joinHex8(parts));
  }

  function commitParts(parts: ColorParts) {
    update(parts);
    onCommit(joinHex8(parts));
  }

  function commitHexText(text: string) {
    const parts = parseHexEntry(text, draft.alphaPct);
    if (parts) commitParts(parts);
  }

  function dropColor(e: ReactDragEvent) {
    e.preventDefault();
    setDragOver(false);
    const payload = e.dataTransfer.getData(COLOR_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    const parsed = parseHexEntry(payload, draft.alphaPct);
    // Dropping copies the hue only — each tint's opacity encodes its role.
    if (parsed) commitParts({ hex: parsed.hex, alphaPct: draft.alphaPct });
  }

  return (
    <li
      className={`color-row ${dragOver ? "dragover" : ""}`}
      onDragOver={(e) => {
        if (!hasColorDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={dropColor}
    >
      <span className="color-label">{spec.label}</span>
      <span
        className="color-sample"
        style={{
          background: `linear-gradient(var(${spec.cssVar}), var(${spec.cssVar})), var(--bg)`,
        }}
        aria-hidden="true"
        draggable
        title="Drag onto another row to copy this hue"
        onDragStart={(e) => {
          e.dataTransfer.setData(COLOR_DRAG_MIME, joinHex8(draft));
          e.dataTransfer.setData("text/plain", joinHex8(draft));
          e.dataTransfer.effectAllowed = "copy";
        }}
      />
      <input
        ref={colorRef}
        type="color"
        value={draft.hex}
        aria-label={`${spec.label} color`}
        onChange={(e) => update({ ...draft, hex: e.target.value })}
      />
      <HexField value={joinHex8(draft)} label={spec.label} onCommit={commitHexText} />
      <input
        ref={rangeRef}
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft.alphaPct}
        aria-label={`${spec.label} opacity`}
        onChange={(e) => update({ ...draft, alphaPct: Number(e.target.value) })}
      />
      <span className="color-pct">{draft.alphaPct}%</span>
      <Button size="small" onClick={() => onCommit(null)} disabled={!overridden}>
        Reset
      </Button>
    </li>
  );
}
