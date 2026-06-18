import { useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../ipc";
import type { ProxySettings } from "../types";
import { ColumnsSettings } from "./ColumnsSettings";

interface SectionProps {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}

interface SectionCtx extends SectionProps {
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  running: boolean;
  onCaChanged: () => void;
}

interface Section {
  id: string;
  label: string;
  render: (ctx: SectionCtx) => ReactNode;
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
        <input
          type="number"
          min={1}
          max={65535}
          style={{ width: 90 }}
          value={settings.port}
          onChange={(e) =>
            onChange({ ...settings, port: Number(e.target.value) || 8080 })
          }
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
          ⚠ Any device on your network can route traffic through this proxy. Only
          enable on trusted networks.
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
        <input
          type="number"
          min={100}
          step={100}
          style={{ width: 100 }}
          value={settings.maxFlows}
          onChange={(e) =>
            onChange({
              ...settings,
              maxFlows: Math.max(100, Number(e.target.value) || 5000),
            })
          }
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
        When set, only matching hosts are intercepted &amp; recorded — everything
        else is tunneled. Same subdomain matching as exclusions.
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
                ✕
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
        Add an artificial delay before each response to simulate a slow network.
        Applies to live captured responses (not mocked ones).
      </p>
      <div className="row">
        <label>Response delay</label>
        <input
          type="number"
          min={0}
          step={100}
          style={{ width: 100 }}
          value={settings.responseDelayMs}
          onChange={(e) =>
            onChange({
              ...settings,
              responseDelayMs: Math.max(0, Number(e.target.value) || 0),
            })
          }
        />
        <span className="muted small">
          ms {settings.responseDelayMs === 0 ? "(off)" : ""}
        </span>
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

function CertificatesSection({
  running,
  onCaChanged,
}: {
  running: boolean;
  onCaChanged: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doExport() {
    setErr(null);
    setMsg(null);
    try {
      await api.exportCa();
    } catch (e) {
      setErr(String(e));
    }
  }
  async function doRegenerate() {
    setErr(null);
    setMsg(null);
    try {
      await api.regenerateCa();
      onCaChanged();
      setMsg("New CA generated — re-trust it (CA certificate button) and restart apps.");
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="settings-pane">
      <h4>Certificates</h4>
      <p className="muted small">
        Germi signs intercepted HTTPS with its own root CA. Trust it once — the
        <strong> CA certificate</strong> toolbar button has the instructions.
      </p>
      <div className="col-add-list">
        <button className="btn" onClick={doExport}>
          Export CA to file…
        </button>
        <button
          className="btn danger"
          onClick={doRegenerate}
          disabled={running}
          title={running ? "Stop the proxy first" : undefined}
        >
          Regenerate CA
        </button>
      </div>
      {running && (
        <p className="muted small">Stop the proxy to regenerate the CA.</p>
      )}
      {msg && <p className="small settings-ok">{msg}</p>}
      {err && <p className="settings-err">{err}</p>}
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
        Listed hosts bypass Germi entirely — their HTTPS is tunneled straight
        through without decryption or capture, and HTTP is forwarded unrecorded.
        Enter a domain like <code>spotify.com</code>; subdomains (e.g.{" "}
        <code>api.spotify.com</code>) are matched too.
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
        <div className="muted small excluded-empty">
          No exclusions — everything is intercepted.
        </div>
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
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Props {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  running: boolean;
  onCaChanged: () => void;
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  onChange,
  columnOrder,
  onColumnOrderChange,
  running,
  onCaChanged,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState(SECTIONS[0].id);
  const [err, setErr] = useState<string | null>(null);
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    dlg.setAttribute("closedby", "any");
    if (!dlg.open) dlg.showModal();
    const onCloseEvent = () => onClose();
    const onClick = (e: MouseEvent) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside =
        r.top <= e.clientY &&
        e.clientY <= r.top + r.height &&
        r.left <= e.clientX &&
        e.clientX <= r.left + r.width;
      if (!inside) dlg.close();
    };
    dlg.addEventListener("close", onCloseEvent);
    dlg.addEventListener("click", onClick);
    return () => {
      dlg.removeEventListener("close", onCloseEvent);
      dlg.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function exportSettings() {
    setErr(null);
    try {
      await api.exportSettings();
    } catch (e) {
      setErr(String(e));
    }
  }
  async function importSettings() {
    setErr(null);
    try {
      onChange(await api.importSettings());
    } catch (e) {
      setErr(String(e));
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
          ✕
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
            running,
            onCaChanged,
          })}
        </div>
      </div>

      <div className="settings-foot">
        <div className="settings-foot-left">
          <button className="btn" onClick={importSettings} title="Import settings from a JSON file">
            Import…
          </button>
          <button className="btn" onClick={exportSettings} title="Export settings to a JSON file">
            Export…
          </button>
        </div>
        {err && <span className="settings-err">{err}</span>}
        <button className="btn primary" onClick={() => ref.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
