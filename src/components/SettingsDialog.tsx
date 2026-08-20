import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { clamp } from "es-toolkit";

import { accelFromKeyboardEvent, prettyAccel } from "../hotkey";
import {
  accelFromEvent,
  DEFAULT_SHORTCUTS,
  findConflict,
  prettyShortcut,
  SHORTCUT_COMMANDS,
  type Bindings,
  type CommandId,
} from "../shortcuts";
import { useHotkeyMode } from "../useHotkeyMode";
import type { AutoLayout } from "../appState";
import { hasUnsavedSettingsChanges, type SettingsDialogDraft } from "../settingsDraft";
import { applyAppearance } from "../theme";
import type { ProxySettings, SettingsSectionSummary } from "../types";
import { useToast } from "../toast";
import { AppearanceSettings } from "./AppearanceSettings";
import { ColumnsSettings } from "./ColumnsSettings";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsSectionsDialog } from "./SettingsSectionsDialog";
import { IconClose, IconWarn } from "./icons";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Modal } from "./ui/Modal";

interface SectionProps {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}

type SettingsAppearance = Pick<ProxySettings, "theme" | "highlightColors">;

interface SectionCtx extends SectionProps {
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  shortcuts: Bindings;
  onShortcutsChange: (b: Bindings) => void;
  autoLayout: AutoLayout;
  onAutoLayoutChange: (layout: AutoLayout) => void;
  running: boolean;
  portError: string | null;
  onCaChanged: () => void;
  onExportCa: () => Promise<boolean>;
  onRegenerateCa: () => Promise<void>;
  onPreviewAppearance: (appearance: SettingsAppearance) => void;
  onNumericDraftChange: (field: string, dirty: boolean) => void;
}

interface Section {
  id: string;
  label: string;
  render: (ctx: SectionCtx) => ReactNode;
}

/** A controlled numeric input that keeps a local draft string so the field can
 *  be cleared/edited freely, then commits a clamped INTEGER on blur/Enter. This
 *  avoids two bugs: typing an out-of-range value (e.g. a port > 65535) that the
 *  Rust u16 rejects (silently desyncing the UI from the backend), and the
 *  field snapping to a fallback mid-edit when momentarily empty. */
function NumberField({
  value,
  min,
  max,
  fallback,
  step,
  width,
  onCommit,
  onDirtyChange,
}: {
  value: number;
  min: number;
  max?: number;
  fallback: number;
  step?: number;
  width?: number;
  onCommit: (n: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  // Resync when the committed value changes from outside (e.g. import settings).
  useEffect(() => {
    setDraft(String(value));
    onDirtyChangeRef.current?.(false);
  }, [value]);
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  const commit = () => {
    const parsed = Math.trunc(Number(draft));
    let n = draft.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
    n = clamp(n, min, max ?? Infinity);
    onCommit(n);
    setDraft(String(n));
    onDirtyChange?.(false);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      style={{ width }}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        onDirtyChange?.(next !== String(value));
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// Extensible registry: to add a settings category, append a section here and a
// component below. The nav and content area are driven entirely by this list.
const SECTIONS: Section[] = [
  {
    id: "connections",
    label: "Connections",
    render: (c) => (
      <ConnectionsSection
        settings={c.settings}
        onChange={c.onChange}
        running={c.running}
        portError={c.portError}
        onNumericDraftChange={(dirty) => c.onNumericDraftChange("port", dirty)}
      />
    ),
  },
  {
    id: "certificates",
    label: "Certificates",
    render: (c) => (
      <CertificatesSection
        running={c.running}
        onCaChanged={c.onCaChanged}
        onExportCa={c.onExportCa}
        onRegenerateCa={c.onRegenerateCa}
      />
    ),
  },
  {
    id: "interception",
    label: "Interception",
    render: (c) => <InterceptionSection settings={c.settings} onChange={c.onChange} />,
  },
  {
    id: "capture",
    label: "Capture",
    render: (c) => (
      <CaptureSection
        settings={c.settings}
        onChange={c.onChange}
        onNumericDraftChange={(dirty) => c.onNumericDraftChange("maxFlows", dirty)}
      />
    ),
  },
  {
    id: "throttling",
    label: "Throttling",
    render: (c) => (
      <ThrottlingSection
        settings={c.settings}
        onChange={c.onChange}
        onNumericDraftChange={(dirty) => c.onNumericDraftChange("responseDelayMs", dirty)}
      />
    ),
  },
  {
    id: "autoresponder",
    label: "Autoresponder",
    render: (c) => <AutoresponderSection layout={c.autoLayout} onChange={c.onAutoLayoutChange} />,
  },
  {
    id: "appearance",
    label: "Appearance",
    render: (c) => (
      <AppearanceSettings
        settings={c.settings}
        onChange={c.onChange}
        onPreviewAppearance={c.onPreviewAppearance}
      />
    ),
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    render: (c) => (
      <>
        <HotkeySection settings={c.settings} onChange={c.onChange} />
        <InAppShortcutsSection bindings={c.shortcuts} onChange={c.onShortcutsChange} />
      </>
    ),
  },
  {
    id: "columns",
    label: "Columns",
    render: (c) => (
      <ColumnsSettings
        order={c.columnOrder}
        onOrderChange={c.onColumnOrderChange}
        settings={c.settings}
        onSettingsChange={c.onChange}
      />
    ),
  },
];

function ConnectionsSection({
  settings,
  onChange,
  running,
  portError,
  onNumericDraftChange,
}: SectionProps & {
  running: boolean;
  portError: string | null;
  onNumericDraftChange: (dirty: boolean) => void;
}) {
  return (
    <div className="settings-pane">
      <h4>Connections</h4>
      <div className="row">
        <label>Listen port</label>
        <NumberField
          value={settings.port}
          min={1}
          max={65535}
          fallback={8080}
          width={90}
          onCommit={(port) => onChange({ ...settings, port })}
          onDirtyChange={onNumericDraftChange}
        />
        <span className="muted small">
          {running ? "rebinds the proxy when you Save" : "applied on next Start after you Save"}
        </span>
      </div>
      {portError && (
        <p className="warn small" role="alert">
          <IconWarn /> {portError}
        </p>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.allowRemote}
          onChange={(e) => onChange({ ...settings, allowRemote: e.target.checked })}
        />
        Allow remote devices to connect (bind 0.0.0.0)
        {running && <span className="muted small"> — rebinds the proxy when you Save</span>}
      </label>
      {settings.allowRemote && (
        <p className="warn small">
          <IconWarn /> Any device on your network can route traffic through this proxy. Only enable
          on trusted networks.
        </p>
      )}
      <p className="muted small">
        To capture from a phone or another machine, point its HTTP proxy at{" "}
        <code>your-ip:{settings.port}</code> and trust the Germi CA there.
      </p>
    </div>
  );
}

function CaptureSection({
  settings,
  onChange,
  onNumericDraftChange,
}: SectionProps & { onNumericDraftChange: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState("");
  const filter = settings.captureFilter;

  function addFilter() {
    const h = normalizeHost(draft);
    if (!h || filter.includes(h)) {
      setDraft("");
      return;
    }
    onChange({ ...settings, captureFilter: [...filter, h] });
    setDraft("");
  }

  return (
    <div className="settings-pane fill">
      <h4>Capture</h4>
      <div className="row">
        <label>Keep last</label>
        <NumberField
          value={settings.maxFlows}
          min={100}
          fallback={5000}
          step={100}
          width={100}
          onCommit={(maxFlows) => onChange({ ...settings, maxFlows })}
          onDirtyChange={onNumericDraftChange}
        />
        <span className="muted small">flows in memory (oldest evicted)</span>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.autoStartOnLaunch}
          onChange={(e) => onChange({ ...settings, autoStartOnLaunch: e.target.checked })}
        />
        Start the proxy automatically on launch
      </label>
      <p className="muted small">
        On by default — the listener is harmless until you route the system proxy through Germi, and
        it saves a click. If the port is taken at launch, you&apos;ll be told so you can change it
        above.
      </p>

      <div className="col-section-label">Capture filter (record only these hosts)</div>
      <p className="muted small">
        When set, only matching hosts are intercepted &amp; recorded — everything else is tunneled.
        Same subdomain matching as exclusions.
      </p>
      <div className="excluded-add">
        <input
          value={draft}
          placeholder="api.example.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFilter();
            }
          }}
        />
        <Button onClick={addFilter} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {filter.length === 0 ? (
        <div className="muted small excluded-empty">
          No filter — capturing all non-excluded hosts.
        </div>
      ) : (
        <ul className="excluded-list">
          {filter.map((h) => (
            <li key={h}>
              <span className="ehost">{h}</span>
              <IconButton
                danger
                label={`Remove ${h}`}
                onClick={() =>
                  onChange({
                    ...settings,
                    captureFilter: filter.filter((x) => x !== h),
                  })
                }
              >
                <IconClose />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThrottlingSection({
  settings,
  onChange,
  onNumericDraftChange,
}: SectionProps & { onNumericDraftChange: (dirty: boolean) => void }) {
  const presets = [0, 200, 500, 1000, 2000, 5000];
  return (
    <div className="settings-pane">
      <h4>Throttling</h4>
      <p className="muted small">
        Add an artificial delay before each response to simulate a slow network. Applies to both
        live upstream and mocked responses.
      </p>
      <div className="row">
        <label>Response delay</label>
        <NumberField
          value={settings.responseDelayMs}
          min={0}
          fallback={0}
          step={100}
          width={100}
          onCommit={(responseDelayMs) => onChange({ ...settings, responseDelayMs })}
          onDirtyChange={onNumericDraftChange}
        />
        <span className="muted small">ms {settings.responseDelayMs === 0 ? "(off)" : ""}</span>
      </div>
      <div className="col-add-list">
        {presets.map((p) => (
          <Button
            key={p}
            size="small"
            active={settings.responseDelayMs === p}
            onClick={() => onChange({ ...settings, responseDelayMs: p })}
          >
            {p === 0 ? "Off" : `${p} ms`}
          </Button>
        ))}
      </div>
    </div>
  );
}

const AUTO_LAYOUTS: { value: AutoLayout; label: string; hint: string }[] = [
  { value: "side", label: "Side by side", hint: "Rule list on the left, details on the right." },
  { value: "stacked", label: "Stacked", hint: "Rule list on top, details below." },
];

function AutoresponderSection({
  layout,
  onChange,
}: {
  layout: AutoLayout;
  onChange: (layout: AutoLayout) => void;
}) {
  return (
    <div className="settings-pane">
      <h4>Autoresponder</h4>
      <p className="muted small">
        Where the rule detail editor sits relative to the rule list. Double-click a rule to pop its
        details out into a separate, movable window instead — you can open several at once, and
        press Esc to close one.
      </p>
      <div className="col-section-label">Detail layout</div>
      <div className="col-add-list">
        {AUTO_LAYOUTS.map((o) => (
          <Button
            key={o.value}
            size="small"
            active={layout === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      <p className="muted small">{AUTO_LAYOUTS.find((o) => o.value === layout)?.hint}</p>
    </div>
  );
}

function HotkeySection({ settings, onChange }: SectionProps) {
  const [recording, setRecording] = useState(false);
  const mode = useHotkeyMode();
  const accel = settings.systemProxyHotkey;

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const next = accelFromKeyboardEvent(e);
      if (next) {
        onChange({ ...settings, systemProxyHotkey: next });
        setRecording(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, settings, onChange]);

  return (
    <div className="settings-pane">
      <h4>Shortcuts</h4>
      <p className="muted small">
        A global hotkey toggles the system proxy on or off — even when Germi isn&apos;t focused. A
        system notification confirms the new state, and the proxy auto-starts first if it isn&apos;t
        running.
      </p>
      <div className="row hotkey-row">
        <label>Toggle system proxy</label>
        <span
          className={`btn small hotkey-display ${recording ? "recording" : ""} ${accel ? "" : "unset"}`}
        >
          {recording ? "Press keys…" : accel ? prettyAccel(accel) : "Not set"}
        </span>
        <Button size="small" onClick={() => setRecording((r) => !r)}>
          {recording ? "Cancel" : "Record"}
        </Button>
        <Button
          size="small"
          onClick={() => onChange({ ...settings, systemProxyHotkey: "" })}
          disabled={!accel || recording}
        >
          Clear
        </Button>
      </div>
      <p className="muted small">
        Use Ctrl, Alt, or Win/Super (optionally with Shift) plus a letter, digit, or function key —
        e.g. <kbd>Ctrl+Shift+P</kbd> or <kbd>Win+F12</kbd>. Some Win/Super combos are reserved by
        the OS and may fail to register. Press Esc while recording to cancel.
      </p>
      {mode === "portal" && (
        <p className="muted small">
          On Wayland, your desktop owns global shortcuts: when you set one, GNOME/KDE confirms it
          via a system prompt, and you can change the key under the desktop&apos;s keyboard
          settings. The combo above is the suggested trigger.
        </p>
      )}
    </div>
  );
}

function labelOf(id: CommandId): string {
  return SHORTCUT_COMMANDS.find((c) => c.id === id)?.label ?? id;
}

/** Editor for the in-app (focus-only) keyboard shortcuts. Bindings live in
 *  localStorage (frontend-only), so this edits them directly rather than through
 *  ProxySettings. The recorder mirrors HotkeySection's capture-phase listener. */
function InAppShortcutsSection({
  bindings,
  onChange,
}: {
  bindings: Bindings;
  onChange: (b: Bindings) => void;
}) {
  const [recordingId, setRecordingId] = useState<CommandId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (!recordingId) return;
    const id = recordingId;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return;
      const clash = findConflict(bindings, accel, id);
      if (clash) {
        setConflict(
          clash.kind === "reserved"
            ? `${prettyShortcut(accel)} is reserved by Germi`
            : `${prettyShortcut(accel)} is already used by “${labelOf(clash.id)}”`,
        );
        return;
      }
      onChange({ ...bindings, [id]: accel });
      setRecordingId(null);
      setConflict(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, bindings, onChange]);

  function record(id: CommandId) {
    setConflict(null);
    setRecordingId((cur) => (cur === id ? null : id));
  }

  return (
    <div className="settings-pane">
      <h4>In-app shortcuts</h4>
      <p className="muted small">
        These work while Germi is focused. Click Record, then press the keys (Esc cancels). Use
        Ctrl, Alt, or ⌘ — optionally with Shift — plus a key, or a function key like <kbd>F2</kbd>.
      </p>
      <ul className="shortcut-grid">
        {SHORTCUT_COMMANDS.map((c) => {
          const recording = recordingId === c.id;
          return (
            <li className="shortcut-row" key={c.id}>
              <span className="shortcut-cmd">{c.label}</span>
              <span className={`btn small hotkey-display ${recording ? "recording" : ""}`}>
                {recording ? "Press keys…" : prettyShortcut(bindings[c.id])}
              </span>
              <Button size="small" onClick={() => record(c.id)}>
                {recording ? "Cancel" : "Record"}
              </Button>
              <Button
                size="small"
                onClick={() => onChange({ ...bindings, [c.id]: DEFAULT_SHORTCUTS[c.id] })}
                disabled={bindings[c.id] === DEFAULT_SHORTCUTS[c.id] || recording}
              >
                Reset
              </Button>
            </li>
          );
        })}
      </ul>
      {conflict && (
        <p className="warn small">
          <IconWarn /> {conflict}
        </p>
      )}
      <div className="col-add-list">
        <Button size="small" onClick={() => onChange(DEFAULT_SHORTCUTS)}>
          Reset all to defaults
        </Button>
      </div>
    </div>
  );
}

function CertificatesSection({
  running,
  onCaChanged,
  onExportCa,
  onRegenerateCa,
}: {
  running: boolean;
  onCaChanged: () => void;
  onExportCa: () => Promise<boolean>;
  onRegenerateCa: () => Promise<void>;
}) {
  const notify = useToast();
  const [pendingRegen, setPendingRegen] = useState(false);

  async function doExport() {
    try {
      const ok = await onExportCa();
      if (ok) notify("success", "CA certificate exported");
    } catch (e) {
      notify("error", String(e));
    }
  }
  async function doRegenerate() {
    setPendingRegen(false);
    try {
      await onRegenerateCa();
      onCaChanged();
      notify("success", "New CA generated — re-trust it (CA cert button) and restart apps.");
    } catch (e) {
      notify("error", String(e));
    }
  }

  return (
    <div className="settings-pane">
      <h4>Certificates</h4>
      <p className="muted small">
        Germi signs intercepted HTTPS with its own root CA. Trust it once — the
        <strong> CA cert</strong> toolbar button has the instructions.
      </p>
      <div className="col-add-list">
        <Button onClick={doExport}>Export CA to file…</Button>
        <Button
          danger
          onClick={() => setPendingRegen(true)}
          disabled={running}
          title={running ? "Stop the proxy first" : undefined}
        >
          Regenerate CA
        </Button>
      </div>
      {running && <p className="muted small">Stop the proxy to regenerate the CA.</p>}
      {pendingRegen && (
        <ConfirmDialog
          title="Regenerate the root CA?"
          message="This replaces the current CA with a new one. Every machine that trusted the old CA must re-trust the new one, and running apps must restart. This can't be undone."
          confirmLabel="Regenerate CA"
          danger
          onConfirm={doRegenerate}
          onCancel={() => setPendingRegen(false)}
        />
      )}
    </div>
  );
}

/** Normalize user input to a bare host: strip scheme, path, port, whitespace. */
function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .trim();
}

function InterceptionSection({ settings, onChange }: SectionProps) {
  const [draft, setDraft] = useState("");
  const hosts = settings.excludedHosts;

  function addHost() {
    const h = normalizeHost(draft);
    if (!h || hosts.includes(h)) {
      setDraft("");
      return;
    }
    onChange({ ...settings, excludedHosts: [...hosts, h] });
    setDraft("");
  }
  function removeHost(h: string) {
    onChange({ ...settings, excludedHosts: hosts.filter((x) => x !== h) });
  }

  return (
    <div className="settings-pane fill">
      <h4>Host exclusions</h4>
      <p className="muted small">
        Listed hosts bypass Germi entirely — their HTTPS is tunneled straight through without
        decryption or capture, and HTTP is forwarded unrecorded. Enter a domain like{" "}
        <code>spotify.com</code>; subdomains (e.g. <code>api.spotify.com</code>) are matched too.
      </p>

      <div className="excluded-add">
        <input
          value={draft}
          placeholder="spotify.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addHost();
            }
          }}
        />
        <Button onClick={addHost} disabled={!draft.trim()}>
          Add
        </Button>
      </div>

      {hosts.length === 0 ? (
        <div className="muted small excluded-empty">No exclusions — everything is intercepted.</div>
      ) : (
        <ul className="excluded-list">
          {hosts.map((h) => (
            <li key={h}>
              <span className="ehost">{h}</span>
              <IconButton danger label={`Remove ${h}`} onClick={() => removeHost(h)}>
                <IconClose />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface SettingsDialogProps {
  settings: ProxySettings;
  /** Immutable transaction base captured when the modeless window was seeded. */
  baselineDraft?: SettingsDialogDraft;
  columnOrder: string[];
  shortcuts: Bindings;
  autoLayout: AutoLayout;
  running: boolean;
  portError: string | null;
  onCaChanged: () => void;
  onImportApplied: (s: ProxySettings) => void;
  onFlushSettings: () => Promise<void>;
  onSave: (draft: SettingsDialogDraft) => Promise<SettingsDialogDraft | void>;
  onClose: () => void | Promise<void>;
  onGetSettingsSections: () => Promise<SettingsSectionSummary[]>;
  onExportSettings: (sections: string[]) => Promise<boolean>;
  onPeekSettingsImport: () => Promise<SettingsSectionSummary[] | null>;
  onApplySettingsImport: (sections: string[]) => Promise<ProxySettings>;
  onExportCa: () => Promise<boolean>;
  onRegenerateCa: () => Promise<void>;
  onPreviewAppearance?: (appearance: SettingsAppearance) => void;
  standalone?: boolean;
  closeRequest?: number;
  onCloseRequestCancelled?: () => void;
  onSavingChange?: (saving: boolean) => void;
}

function loadSection(): string {
  try {
    const saved = localStorage.getItem("germi.settingsSection");
    return saved && SECTIONS.some((s) => s.id === saved) ? saved : SECTIONS[0].id;
  } catch {
    return SECTIONS[0].id;
  }
}

function useSettingsTransfer(
  onFlushSettings: () => Promise<void>,
  onImportApplied: (settings: ProxySettings) => void,
  onImported: (settings: ProxySettings) => void,
  operations: Pick<
    SettingsDialogProps,
    "onGetSettingsSections" | "onExportSettings" | "onPeekSettingsImport" | "onApplySettingsImport"
  >,
) {
  const notify = useToast();
  const [exportSections, setExportSections] = useState<SettingsSectionSummary[] | null>(null);
  const [importPreview, setImportPreview] = useState<SettingsSectionSummary[] | null>(null);

  async function startExport() {
    try {
      await onFlushSettings();
      setExportSections(await operations.onGetSettingsSections());
    } catch (error) {
      notify("error", String(error));
    }
  }

  async function exportSettings(sections: string[]) {
    setExportSections(null);
    try {
      await onFlushSettings();
      if (await operations.onExportSettings(sections)) notify("success", "Settings exported");
    } catch (error) {
      notify("error", String(error));
    }
  }

  async function startImport() {
    try {
      await onFlushSettings();
      setImportPreview(await operations.onPeekSettingsImport());
    } catch (error) {
      notify("error", String(error));
    }
  }

  async function importSettings(sections: string[]) {
    setImportPreview(null);
    try {
      await onFlushSettings();
      const imported = await operations.onApplySettingsImport(sections);
      onImportApplied(imported);
      onImported(imported);
      notify("success", "Settings imported");
    } catch (error) {
      notify("error", String(error));
    }
  }

  return {
    exportSections,
    importPreview,
    startExport,
    exportSettings,
    cancelExport: () => setExportSections(null),
    startImport,
    importSettings,
    cancelImport: () => setImportPreview(null),
  };
}

function useSettingsDialogState({
  settings,
  baselineDraft,
  onImportApplied,
  columnOrder,
  shortcuts,
  autoLayout,
  onFlushSettings,
  onSave,
  onClose,
  onGetSettingsSections,
  onExportSettings,
  onPeekSettingsImport,
  onApplySettingsImport,
  onPreviewAppearance = ({ theme, highlightColors }) => applyAppearance(theme, highlightColors),
}: SettingsDialogProps) {
  const [active, setActive] = useState(loadSection);
  const [draftSettings, setDraftSettings] = useState(settings);
  const [draftColumnOrder, setDraftColumnOrder] = useState(columnOrder);
  const [draftShortcuts, setDraftShortcuts] = useState(shortcuts);
  const [draftAutoLayout, setDraftAutoLayout] = useState(autoLayout);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingNumericEdits, setPendingNumericEdits] = useState<Record<string, boolean>>({});
  const onNumericDraftChange = useCallback((field: string, dirty: boolean) => {
    setPendingNumericEdits((current) => {
      if (Boolean(current[field]) === dirty) return current;
      if (dirty) return { ...current, [field]: true };
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);
  const durableAppearanceRef = useRef({
    theme: settings.theme,
    highlightColors: settings.highlightColors,
  });
  durableAppearanceRef.current = {
    theme: settings.theme,
    highlightColors: settings.highlightColors,
  };
  const savedAppearanceRef = useRef<typeof durableAppearanceRef.current | null>(null);

  function resetAfterImport(imported: ProxySettings) {
    durableAppearanceRef.current = {
      theme: imported.theme,
      highlightColors: imported.highlightColors,
    };
    setDraftSettings(imported);
    setDraftColumnOrder(columnOrder);
    setDraftShortcuts(shortcuts);
    setDraftAutoLayout(autoLayout);
    setActive(loadSection());
    setSaveError(null);
    setPendingNumericEdits({});
    onPreviewAppearance({
      theme: imported.theme,
      highlightColors: imported.highlightColors,
    });
  }

  const transfer = useSettingsTransfer(onFlushSettings, onImportApplied, resetAfterImport, {
    onGetSettingsSections,
    onExportSettings,
    onPeekSettingsImport,
    onApplySettingsImport,
  });

  const currentDraft: SettingsDialogDraft = {
    settings: draftSettings,
    columnOrder: draftColumnOrder,
    shortcuts: draftShortcuts,
    autoLayout: draftAutoLayout,
    activeSection: active,
  };
  const savedDraft: SettingsDialogDraft = baselineDraft ?? {
    settings,
    columnOrder,
    shortcuts,
    autoLayout,
    activeSection: active,
  };

  useEffect(() => {
    return () => {
      const appearance = savedAppearanceRef.current ?? durableAppearanceRef.current;
      applyAppearance(appearance.theme, appearance.highlightColors);
    };
  }, []);

  function discard() {
    const appearance = durableAppearanceRef.current;
    onPreviewAppearance(appearance);
    void Promise.resolve(onClose()).catch((error: unknown) =>
      setSaveError(error instanceof Error ? error.message : String(error)),
    );
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const persisted = (await onSave(currentDraft)) ?? currentDraft;
      setDraftSettings(persisted.settings);
      setDraftColumnOrder(persisted.columnOrder);
      setDraftShortcuts(persisted.shortcuts);
      setDraftAutoLayout(persisted.autoLayout);
      setActive(persisted.activeSection);
      setPendingNumericEdits({});
      durableAppearanceRef.current = {
        theme: persisted.settings.theme,
        highlightColors: persisted.settings.highlightColors,
      };
      savedAppearanceRef.current = {
        theme: persisted.settings.theme,
        highlightColors: persisted.settings.highlightColors,
      };
      applyAppearance(persisted.settings.theme, persisted.settings.highlightColors);
      await onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  }

  return {
    active,
    setActive,
    draftSettings,
    setDraftSettings,
    draftColumnOrder,
    setDraftColumnOrder,
    draftShortcuts,
    setDraftShortcuts,
    draftAutoLayout,
    setDraftAutoLayout,
    saving,
    saveError,
    dirty:
      hasUnsavedSettingsChanges(currentDraft, savedDraft) ||
      Object.keys(pendingNumericEdits).length > 0,
    onNumericDraftChange,
    transfer,
    discard,
    save,
  };
}

export function SettingsDialog({
  running,
  portError,
  onCaChanged,
  onExportCa,
  onRegenerateCa,
  onPreviewAppearance = ({ theme, highlightColors }) => applyAppearance(theme, highlightColors),
  standalone = false,
  closeRequest = 0,
  onCloseRequestCancelled,
  onSavingChange,
  ...props
}: SettingsDialogProps) {
  const state = useSettingsDialogState({
    running,
    portError,
    onCaChanged,
    onExportCa,
    onRegenerateCa,
    onPreviewAppearance,
    standalone,
    closeRequest,
    onCloseRequestCancelled,
    onSavingChange,
    ...props,
  });
  const section = SECTIONS.find((s) => s.id === state.active) ?? SECTIONS[0];
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!confirmDiscard && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      returnFocusRef.current?.focus();
    }
  }, [confirmDiscard]);

  function requestDiscardConfirmation(returnFocus: HTMLElement | null) {
    returnFocusRef.current = returnFocus;
    setConfirmDiscard(true);
  }

  function keepEditing() {
    restoreFocusRef.current = true;
    setConfirmDiscard(false);
    onCloseRequestCancelled?.();
  }

  function requestClose(returnFocus: HTMLElement | null) {
    if (state.saving) return;
    if (state.dirty) requestDiscardConfirmation(returnFocus);
    else state.discard();
  }

  useEffect(() => onSavingChange?.(state.saving), [onSavingChange, state.saving]);

  useEffect(() => {
    if (closeRequest > 0)
      requestClose(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // A monotonically increasing request token deliberately triggers this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRequest]);

  // Escape is routed to the topmost native dialog. Dirty Settings intercepts
  // its close request before native dismissal; while the confirmation is
  // topmost, Escape keeps the draft and restores the prior Settings focus.

  const content = (close: () => void) => (
    <>
      <div className="settings-head">
        {standalone ? <h1 id="settings-title">Settings</h1> : <h3 id="settings-title">Settings</h3>}
        <IconButton
          label="Close settings"
          onClick={(event) => requestClose(event.currentTarget)}
          disabled={state.saving}
        >
          <IconClose />
        </IconButton>
      </div>

      <div className="settings-body" inert={state.saving} aria-busy={state.saving}>
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${s.id === state.active ? "on" : ""}`}
              onClick={() => state.setActive(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section.render({
            settings: state.draftSettings,
            onChange: state.saving ? () => {} : state.setDraftSettings,
            columnOrder: state.draftColumnOrder,
            onColumnOrderChange: state.setDraftColumnOrder,
            shortcuts: state.draftShortcuts,
            onShortcutsChange: state.setDraftShortcuts,
            autoLayout: state.draftAutoLayout,
            onAutoLayoutChange: state.setDraftAutoLayout,
            running,
            portError,
            onCaChanged,
            onExportCa,
            onRegenerateCa,
            onPreviewAppearance: state.saving ? () => {} : onPreviewAppearance,
            onNumericDraftChange: state.onNumericDraftChange,
          })}
        </div>
      </div>

      <div className="settings-foot">
        <div className="settings-foot-left">
          <Button
            onClick={state.transfer.startImport}
            disabled={state.saving}
            title="Import settings from a JSON file (you'll review what it changes first)"
          >
            Import…
          </Button>
          <Button
            onClick={state.transfer.startExport}
            disabled={state.saving}
            title="Export selected settings to a JSON file"
          >
            Export…
          </Button>
        </div>
        {state.saveError && (
          <p className="settings-err" role="alert">
            {state.saveError}
          </p>
        )}
        <Button onClick={close} disabled={state.saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={state.save} disabled={state.saving}>
          {state.saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {state.transfer.exportSections && (
        <SettingsSectionsDialog
          title="Export settings"
          message="Only saved values are exported. Pick what goes into the file — e.g. only host exclusions to share them with colleagues."
          sections={state.transfer.exportSections}
          confirmLabel="Export…"
          onConfirm={state.transfer.exportSettings}
          onCancel={state.transfer.cancelExport}
        />
      )}
      {state.transfer.importPreview && (
        <SettingsSectionsDialog
          title="Import settings"
          message="Import applies the checked settings immediately and discards other unsaved edits in this Settings window. Everything else stays as currently saved."
          sections={state.transfer.importPreview}
          confirmLabel="Import"
          onConfirm={state.transfer.importSettings}
          onCancel={state.transfer.cancelImport}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Closing Settings will discard every change you haven't saved."
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          danger
          onConfirm={state.discard}
          onCancel={keepEditing}
        />
      )}
    </>
  );

  if (standalone) {
    return <main className="settings-window">{content(state.discard)}</main>;
  }

  return (
    <Modal
      className="settings-modal"
      ariaLabelledby="settings-title"
      onClose={state.discard}
      dismissible={!state.saving}
      shouldCloseOnRequest={() => {
        if (!state.dirty) return true;
        requestDiscardConfirmation(
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
        );
        return false;
      }}
    >
      {content}
    </Modal>
  );
}
