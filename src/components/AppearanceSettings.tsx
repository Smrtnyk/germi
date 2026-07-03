import { Fragment, useEffect, useRef, useState, type MutableRefObject } from "react";
import { isEqual } from "es-toolkit";

import {
  applyHighlightColors,
  effectiveColor,
  HIGHLIGHT_COLORS,
  joinHex8,
  splitHex8,
  withOverride,
  type ColorParts,
  type HighlightColorSpec,
} from "../theme";
import type { ProxySettings } from "../types";

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
        <button className="btn small" onClick={resetAll} disabled={!anyOverridden}>
          Reset all to defaults
        </button>
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
  useEffect(() => setDraft(splitHex8(effective)), [effective]);

  const commitRef = useRef(() => {});
  commitRef.current = () => onCommit(joinHex8(draft));
  const colorRef = useCommitOnNativeChange(commitRef);
  const rangeRef = useCommitOnNativeChange(commitRef);

  function update(parts: ColorParts) {
    setDraft(parts);
    onPreview(joinHex8(parts));
  }

  return (
    <li className="color-row">
      <span className="color-label">{spec.label}</span>
      <span
        className="color-sample"
        style={{
          background: `linear-gradient(var(${spec.cssVar}), var(${spec.cssVar})), var(--bg)`,
        }}
        aria-hidden="true"
      />
      <input
        ref={colorRef}
        type="color"
        value={draft.hex}
        aria-label={`${spec.label} color`}
        onChange={(e) => update({ ...draft, hex: e.target.value })}
      />
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
      <button className="btn small" onClick={() => onCommit(null)} disabled={!overridden}>
        Reset
      </button>
    </li>
  );
}
