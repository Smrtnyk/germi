import type { RefObject } from "react";

import { FilterHelp } from "./FilterHelp";

interface ToolbarProps {
  running: boolean;
  busy: boolean;
  port: number;
  onPortChange: (port: number) => void;
  onToggleProxy: () => void;
  systemProxy: boolean;
  onToggleSystemProxy: () => void;
  onInstallCa: () => void;
  decode: boolean;
  onToggleDecode: () => void;
  onOpenSettings: () => void;
  onOpen: () => void;
  onSaveSession: () => void;
  onClear: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
}

export function Toolbar(props: ToolbarProps) {
  const {
    running,
    busy,
    port,
    onPortChange,
    onToggleProxy,
    systemProxy,
    onToggleSystemProxy,
    onInstallCa,
    decode,
    onToggleDecode,
    onOpenSettings,
    onOpen,
    onSaveSession,
    onClear,
    filter,
    onFilterChange,
    filterInputRef,
  } = props;

  return (
    <header className="toolbar">
      <div className="brand">
        <span className={`dot ${running ? "on" : ""}`} />
        Germi
      </div>

      <div className="tb-group" role="group" aria-label="Proxy">
        <button
          className={running ? "btn danger" : "btn primary"}
          onClick={onToggleProxy}
          disabled={busy}
          title={running ? "Stop the proxy" : "Start the proxy"}
        >
          {busy ? (running ? "Stopping…" : "Starting…") : running ? "■ Stop" : "▶ Start"}
        </button>

        <label className="port">
          :
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            disabled={running || busy}
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
      </div>

      <div className="tb-sep" />

      <div className="tb-group" role="group" aria-label="Session">
        <button
          className="btn ghost"
          onClick={onOpen}
          title="Open a .germi session, HAR or Fiddler SAZ archive (replaces current traffic)"
        >
          Open
        </button>
        <button
          className="btn ghost"
          onClick={onSaveSession}
          title="Save current traffic to a .germi session"
        >
          Save
        </button>
        <button className="btn ghost danger" onClick={onClear} title="Clear captured traffic">
          Clear
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group" role="group" aria-label="View">
        <button
          className={decode ? "btn active" : "btn ghost"}
          onClick={onToggleDecode}
          title="Decompress gzip / brotli / deflate response bodies"
        >
          Decode
        </button>
        <button
          className="btn ghost"
          onClick={onInstallCa}
          title="Trust the Germi root CA for HTTPS"
        >
          CA cert
        </button>
        <button
          className="btn ghost"
          onClick={onOpenSettings}
          title="Settings — connections, certificates, interception, capture"
        >
          ⚙ Settings
        </button>
      </div>

      <div className="spacer" />

      <div className="filter-wrap">
        <input
          ref={filterInputRef}
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
      <FilterHelp filter={filter} onPick={onFilterChange} inputRef={filterInputRef} />
    </header>
  );
}
