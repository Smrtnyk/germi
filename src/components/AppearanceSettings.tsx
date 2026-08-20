import { Fragment, useState, type DragEvent as ReactDragEvent } from "react";
import { isEqual } from "es-toolkit";

import { COLOR_DRAG_MIME, hasColorDrag } from "../dnd";
import {
  applyAppearance,
  effectiveColor,
  HIGHLIGHT_COLORS,
  joinHex8,
  parseHexEntry,
  splitHex8,
  useTheme,
  withOverride,
  type HighlightColorSpec,
} from "../theme";
import type { ProxySettings } from "../types";
import { ColorPicker } from "./ColorPicker";
import { Button } from "./ui/Button";
import { IconMoon, IconSun, IconSystemTheme } from "./icons";
import { SegmentedControl } from "./ui/SegmentedControl";

const GROUPS: { id: HighlightColorSpec["group"]; label: string }[] = [
  { id: "rows", label: "Traffic rows" },
  { id: "diff", label: "Compare & diff" },
];

/**
 * Settings → Appearance (issue #93): every highlight tint the app uses, as a
 * shared color + opacity picker. Drafts preview by writing the custom
 * properties directly; Apply updates the Settings draft and Settings Save
 * persists it.
 */
export function AppearanceSettings({
  settings,
  onChange,
}: {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}) {
  const colors = settings.highlightColors;
  const resolvedTheme = useTheme();

  function commit(spec: HighlightColorSpec, value: string | null) {
    const next = withOverride(colors, spec, value, resolvedTheme);
    applyAppearance(settings.theme, next);
    if (!isEqual(next, colors)) onChange({ ...settings, highlightColors: next });
  }

  function resetAll() {
    applyAppearance(settings.theme, {});
    onChange({ ...settings, highlightColors: {} });
  }

  const anyOverridden = HIGHLIGHT_COLORS.some((s) => colors[s.key] !== undefined);

  return (
    <div className="settings-pane">
      <h4>Appearance</h4>
      <div className="appearance-theme">
        <div>
          <div className="appearance-theme-label">Color theme</div>
          <div className="muted small">Applied to every Germi window and editor.</div>
        </div>
        <SegmentedControl
          ariaLabel="Color theme"
          value={settings.theme}
          options={[
            {
              value: "system",
              label: (
                <>
                  <IconSystemTheme /> System
                </>
              ),
            },
            {
              value: "dark",
              label: (
                <>
                  <IconMoon /> Dark
                </>
              ),
            },
            {
              value: "light",
              label: (
                <>
                  <IconSun /> Light
                </>
              ),
            },
          ]}
          onChange={(theme) => {
            applyAppearance(theme, colors);
            onChange({ ...settings, theme });
          }}
        />
      </div>
      <p className="muted small">
        Highlight tints for the traffic list and the compare window. Most are translucent by design,
        so each color picker includes opacity. Drafts preview live; Apply keeps a choice in this
        Settings draft. Save applies everything; dismissing Settings restores the saved colors.
      </p>
      {GROUPS.map((g) => (
        <Fragment key={g.id}>
          <div className="col-section-label">{g.label}</div>
          <ul className="color-list">
            {HIGHLIGHT_COLORS.filter((s) => s.group === g.id).map((spec) => (
              <ColorRow
                key={spec.key}
                spec={spec}
                effective={effectiveColor(colors, spec, resolvedTheme)}
                overridden={colors[spec.key] !== undefined}
                onPreview={(v) => applyAppearance(settings.theme, { ...colors, [spec.key]: v })}
                onCancel={() => applyAppearance(settings.theme, colors)}
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

function ColorRow({
  spec,
  effective,
  overridden,
  onPreview,
  onCancel,
  onCommit,
}: {
  spec: HighlightColorSpec;
  effective: string;
  overridden: boolean;
  onPreview: (value: string) => void;
  onCancel: () => void;
  onCommit: (value: string | null) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const value = splitHex8(effective);

  function dropColor(e: ReactDragEvent) {
    e.preventDefault();
    setDragOver(false);
    const payload = e.dataTransfer.getData(COLOR_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    const parsed = parseHexEntry(payload, value.alphaPct);
    // Dropping copies the hue only — each tint's opacity encodes its role.
    if (parsed) onCommit(joinHex8({ hex: parsed.hex, alphaPct: value.alphaPct }));
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
      <ColorPicker
        label={spec.label}
        value={value}
        swatchBackground={`var(${spec.cssVar})`}
        dataKey={spec.key}
        draggable
        dragTitle="Drag onto another row to copy this hue"
        onDragStart={(e) => {
          e.dataTransfer.setData(COLOR_DRAG_MIME, effective);
          e.dataTransfer.setData("text/plain", effective);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onPreview={(parts) => onPreview(joinHex8(parts))}
        onCancel={onCancel}
        onCommit={(parts) => onCommit(joinHex8(parts))}
      />
      <Button size="small" onClick={() => onCommit(null)} disabled={!overridden}>
        Reset
      </Button>
    </li>
  );
}
