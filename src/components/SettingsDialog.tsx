import { useEffect, useState, type ReactNode } from "react";
import { clamp } from "es-toolkit";

import { api } from "../ipc";
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
import type { ProxySettings } from "../types";
import { useToast } from "../toast";
import { ColumnsSettings } from "./ColumnsSettings";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconClose, IconWarn } from "./icons";
import { useModalDialog } from "./useModalDialog";

interface SectionProps {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}

interface SectionCtx extends SectionProps {
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  shortcuts: Bindings;
  onShortcutsChange: (b: Bindings) => void;
  autoLayout: AutoLayout;
  onAutoLayoutChange: (layout: AutoLayout) => void;
  running: boolean;
  onCaChanged: () => void;
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
}: {
  value: number;
  min: number;
  max?: number;
  fallback: number;
  step?: number;
  width?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // Resync when the committed value changes from outside (e.g. import settings).
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.trunc(Number(draft));
    let n = draft.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
    n = clamp(n, min, max ?? Infinity);
    onCommit(n);
    setDraft(String(n));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      style={{ width }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
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
    render: (c) => <ConnectionsSection settings={c.settings} onChange={c.onChange} />,
  },
  {
    id: "certificates",
    label: "Certificates",
    render: (c) => <CertificatesSection running={c.running} onCaChanged={c.onCaChanged} />,
  },
  {
    id: "interception",
    label: "Interception",
    render: (c) => <InterceptionSection settings={c.settings} onChange={c.onChange} />,
  },
  {
    id: "capture",
    label: "Capture",
    render: (c) => <CaptureSection settings={c.settings} onChange={c.onChange} />,
  },
  {
    id: "throttling",
    label: "Throttling",
    render: (c) => <ThrottlingSection settings={c.settings} onChange={c.onChange} />,
  },
  {
    id: "autoresponder",
    label: "Autoresponder",
    render: (c) => <AutoresponderSection layout={c.autoLayout} onChange={c.onAutoLayoutChange} />,
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

function ConnectionsSection({ settings, onChange }: SectionProps) {
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
        />
        <span className="muted small">applied on next Start</span>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.allowRemote}
          onChange={(e) => onChange({ ...settings, allowRemote: e.target.checked })}
        />
        Allow remote devices to connect (bind 0.0.0.0)
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

function CaptureSection({ settings, onChange }: SectionProps) {
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
    <div className="settings-pane">
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
        />
        <span className="muted small">flows in memory (oldest evicted)</span>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.captureOnStart}
          onChange={(e) => onChange({ ...settings, captureOnStart: e.target.checked })}
        />
        Start capturing automatically on launch
      </label>

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
        <button className="btn" onClick={addFilter} disabled={!draft.trim()}>
          Add
        </button>
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
              <button
                className="x"
                title={`Remove ${h}`}
                onClick={() =>
                  onChange({
                    ...settings,
                    captureFilter: filter.filter((x) => x !== h),
                  })
                }
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThrottlingSection({ settings, onChange }: SectionProps) {
  const presets = [0, 200, 500, 1000, 2000, 5000];
  return (
    <div className="settings-pane">
      <h4>Throttling</h4>
      <p className="muted small">
        Add an artificial delay before each response to simulate a slow network. Applies to live
        captured responses (not mocked ones).
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
        />
        <span className="muted small">ms {settings.responseDelayMs === 0 ? "(off)" : ""}</span>
      </div>
      <div className="col-add-list">
        {presets.map((p) => (
          <button
            key={p}
            className={`btn small ${settings.responseDelayMs === p ? "active" : ""}`}
            onClick={() => onChange({ ...settings, responseDelayMs: p })}
          >
            {p === 0 ? "Off" : `${p} ms`}
          </button>
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
          <button
            key={o.value}
            className={`btn small ${layout === o.value ? "active" : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
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
        <button className="btn small" onClick={() => setRecording((r) => !r)}>
          {recording ? "Cancel" : "Record"}
        </button>
        <button
          className="btn small"
          onClick={() => onChange({ ...settings, systemProxyHotkey: "" })}
          disabled={!accel || recording}
        >
          Clear
        </button>
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
              <button className="btn small" onClick={() => record(c.id)}>
                {recording ? "Cancel" : "Record"}
              </button>
              <button
                className="btn small"
                onClick={() => onChange({ ...bindings, [c.id]: DEFAULT_SHORTCUTS[c.id] })}
                disabled={bindings[c.id] === DEFAULT_SHORTCUTS[c.id] || recording}
              >
                Reset
              </button>
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
        <button className="btn small" onClick={() => onChange(DEFAULT_SHORTCUTS)}>
          Reset all to defaults
        </button>
      </div>
    </div>
  );
}

function CertificatesSection({
  running,
  onCaChanged,
}: {
  running: boolean;
  onCaChanged: () => void;
}) {
  const notify = useToast();
  const [pendingRegen, setPendingRegen] = useState(false);

  async function doExport() {
    try {
      const ok = await api.exportCa();
      if (ok) notify("success", "CA certificate exported");
    } catch (e) {
      notify("error", String(e));
    }
  }
  async function doRegenerate() {
    setPendingRegen(false);
    try {
      await api.regenerateCa();
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
        <button className="btn" onClick={doExport}>
          Export CA to file…
        </button>
        <button
          className="btn danger"
          onClick={() => setPendingRegen(true)}
          disabled={running}
          title={running ? "Stop the proxy first" : undefined}
        >
          Regenerate CA
        </button>
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
    <div className="settings-pane">
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
        <button className="btn" onClick={addHost} disabled={!draft.trim()}>
          Add
        </button>
      </div>

      {hosts.length === 0 ? (
        <div className="muted small excluded-empty">No exclusions — everything is intercepted.</div>
      ) : (
        <ul className="excluded-list">
          {hosts.map((h) => (
            <li key={h}>
              <span className="ehost">{h}</span>
              <button
                className="x"
                title={`Remove ${h}`}
                aria-label={`Remove ${h}`}
                onClick={() => removeHost(h)}
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface SettingsDialogProps {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
  onImportApplied: (s: ProxySettings) => void;
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  shortcuts: Bindings;
  onShortcutsChange: (b: Bindings) => void;
  autoLayout: AutoLayout;
  onAutoLayoutChange: (layout: AutoLayout) => void;
  running: boolean;
  onCaChanged: () => void;
  onClose: () => void;
}

function loadSection(): string {
  try {
    const saved = localStorage.getItem("germi.settingsSection");
    return saved && SECTIONS.some((s) => s.id === saved) ? saved : SECTIONS[0].id;
  } catch {
    return SECTIONS[0].id;
  }
}

export function SettingsDialog({
  settings,
  onChange,
  onImportApplied,
  columnOrder,
  onColumnOrderChange,
  shortcuts,
  onShortcutsChange,
  autoLayout,
  onAutoLayoutChange,
  running,
  onCaChanged,
  onClose,
}: SettingsDialogProps) {
  const notify = useToast();
  const ref = useModalDialog(onClose);
  const [active, setActive] = useState(loadSection);
  const [pendingImport, setPendingImport] = useState(false);
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  useEffect(() => {
    try {
      localStorage.setItem("germi.settingsSection", active);
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [active]);

  async function exportSettings() {
    try {
      const ok = await api.exportSettings();
      if (ok) notify("success", "Settings exported");
    } catch (e) {
      notify("error", String(e));
    }
  }
  async function importSettings() {
    setPendingImport(false);
    try {
      onImportApplied(await api.importSettings());
      notify("success", "Settings imported");
    } catch (e) {
      notify("error", String(e));
    }
  }

  return (
    <dialog ref={ref} className="modal settings-modal" aria-labelledby="settings-title">
      <div className="settings-head">
        <h3 id="settings-title">Settings</h3>
        <button
          className="settings-close"
          aria-label="Close settings"
          onClick={() => ref.current?.close()}
        >
          <IconClose />
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${s.id === active ? "on" : ""}`}
              onClick={() => setActive(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section.render({
            settings,
            onChange,
            columnOrder,
            onColumnOrderChange,
            shortcuts,
            onShortcutsChange,
            autoLayout,
            onAutoLayoutChange,
            running,
            onCaChanged,
          })}
        </div>
      </div>

      <div className="settings-foot">
        <div className="settings-foot-left">
          <button
            className="btn"
            onClick={() => setPendingImport(true)}
            title="Import settings from a JSON file (overwrites current settings)"
          >
            Import…
          </button>
          <button className="btn" onClick={exportSettings} title="Export settings to a JSON file">
            Export…
          </button>
        </div>
        <button className="btn primary" onClick={() => ref.current?.close()}>
          Done
        </button>
      </div>

      {pendingImport && (
        <ConfirmDialog
          title="Import settings?"
          message="This overwrites all current proxy settings (port, exclusions, capture filter, throttling, columns) with the contents of the file you pick. This can't be undone."
          confirmLabel="Choose file & import"
          onConfirm={importSettings}
          onCancel={() => setPendingImport(false)}
        />
      )}
    </dialog>
  );
}
