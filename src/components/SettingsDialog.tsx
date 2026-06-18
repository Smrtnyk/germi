import { useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../ipc";
import type { ProxySettings } from "../types";

interface SectionProps {
  settings: ProxySettings;
  onChange: (s: ProxySettings) => void;
}

interface Section {
  id: string;
  label: string;
  render: (p: SectionProps) => ReactNode;
}

// Extensible registry: to add a settings category, append a section here and a
// component below. The nav and content area are driven entirely by this list.
const SECTIONS: Section[] = [
  {
    id: "interception",
    label: "Interception",
    render: (p) => <InterceptionSection {...p} />,
  },
];

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
  onClose: () => void;
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
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
        <div className="settings-content">{section.render({ settings, onChange })}</div>
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
