import { FilterHelp } from "./FilterHelp";

interface ToolbarProps {
  running: boolean;
  port: number;
  onPortChange: (port: number) => void;
  onToggleProxy: () => void;
  systemProxy: boolean;
  onToggleSystemProxy: () => void;
  onInstallCa: () => void;
  onImport: () => void;
  decode: boolean;
  onToggleDecode: () => void;
  onOpenSettings: () => void;
  onOpenSession: () => void;
  onSaveSession: () => void;
  onClear: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    running,
    port,
    onPortChange,
    onToggleProxy,
    systemProxy,
    onToggleSystemProxy,
    onInstallCa,
    onImport,
    decode,
    onToggleDecode,
    onOpenSettings,
    onOpenSession,
    onSaveSession,
    onClear,
    filter,
    onFilterChange,
  } = props;

  return (
    <header className="toolbar">
      <div className="brand">
        <span className={`dot ${running ? "on" : ""}`} />
        Germi
      </div>

      <button
        className={running ? "btn danger" : "btn primary"}
        onClick={onToggleProxy}
      >
        {running ? "■ Stop" : "▶ Start"}
      </button>

      <label className="port">
        :
        <input
          type="number"
          min={1}
          max={65535}
          value={port}
          disabled={running}
          onChange={(e) => onPortChange(Number(e.target.value) || 8080)}
        />
      </label>

      <button
        className={systemProxy ? "btn active" : "btn"}
        onClick={onToggleSystemProxy}
        disabled={!running}
        title="Route the OS system proxy through Germi"
      >
        {systemProxy ? "System proxy: ON" : "System proxy: off"}
      </button>

      <button className="btn" onClick={onInstallCa}>
        CA certificate
      </button>

      <button className="btn" onClick={onImport} title="Import a HAR or Fiddler SAZ archive">
        Import
      </button>

      <button
        className={decode ? "btn active" : "btn"}
        onClick={onToggleDecode}
        title="Decompress gzip / brotli / deflate response bodies"
      >
        Decode
      </button>

      <button
        className="btn"
        onClick={onOpenSettings}
        title="Settings — exclude hosts from interception"
      >
        ⚙ Settings
      </button>

      <div className="spacer" />

      <div className="filter-wrap">
        <input
          className="filter"
          placeholder="Filter — host: status:4xx kind:xhr body:… -negate /regex/"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          title="Tokens: host: path: method: scheme: status: (4xx, >=400) mime: kind: ext: rule: larger-than: slower-than: body: req-body: resp-body: — bare words match the URL, /regex/ for regex, leading - negates"
        />
        {filter && (
          <button
            className="filter-clear"
            onClick={() => onFilterChange("")}
            title="Clear filter"
            aria-label="Clear filter"
          >
            ✕
          </button>
        )}
      </div>
      <FilterHelp />
      <button
        className="btn"
        onClick={onOpenSession}
        title="Open a saved .germi session (replaces current traffic)"
      >
        Open
      </button>
      <button
        className="btn"
        onClick={onSaveSession}
        title="Save current traffic to a .germi session"
      >
        Save
      </button>
      <button className="btn" onClick={onClear} title="Clear captured traffic">
        Clear
      </button>
    </header>
  );
}
