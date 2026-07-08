import type { RefObject } from "react";

import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { FilterHelp } from "./FilterHelp";
import {
  IconCert,
  IconClear,
  IconClose,
  IconOpen,
  IconSave,
  IconSettings,
  IconStart,
  IconStop,
  IconViewer,
} from "./icons";

interface ToolbarProps {
  running: boolean;
  busy: boolean;
  onToggleProxy: () => void;
  systemProxy: boolean;
  onToggleSystemProxy: () => void;
  /** Viewer mode (`--viewer`): the proxy is disabled; hide the proxy controls. */
  viewer: boolean;
  onLaunchViewer: () => void;
  onInstallCa: () => void;
  decode: boolean;
  onToggleDecode: () => void;
  onOpenSettings: () => void;
  onOpen: () => void;
  onSaveSession: () => void;
  onClear: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
  /** Ctrl/⌘ Enter in the filter bar stores it as a saved filter (issue #90). */
  onSaveFilter: () => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
}

/** The proxy label on the Start/Stop button, split out so the busy/running
 *  branching lives in one small function rather than inflating the toolbar. */
function proxyButtonLabel(running: boolean, busy: boolean) {
  if (busy) return running ? "Stopping…" : "Starting…";
  return running ? (
    <>
      <IconStop /> Stop
    </>
  ) : (
    <>
      <IconStart /> Start
    </>
  );
}

type ProxyControlsProps = Pick<
  ToolbarProps,
  "running" | "busy" | "onToggleProxy" | "systemProxy" | "onToggleSystemProxy"
>;

/** The live-proxy controls (Start/Stop, system proxy). Rendered only outside
 *  viewer mode, where the proxy is disabled. The port lives in Settings. */
function ProxyControls({
  running,
  busy,
  onToggleProxy,
  systemProxy,
  onToggleSystemProxy,
}: ProxyControlsProps) {
  return (
    <div className="tb-group" role="group" aria-label="Proxy">
      <Button
        variant={running ? "default" : "primary"}
        danger={running}
        onClick={onToggleProxy}
        disabled={busy}
        title={running ? "Stop the proxy" : "Start the proxy"}
      >
        {proxyButtonLabel(running, busy)}
      </Button>

      <Button
        active={systemProxy}
        onClick={onToggleSystemProxy}
        disabled={!running}
        title="Route the OS system proxy through Germi"
      >
        {systemProxy ? "System proxy: ON" : "System proxy: off"}
      </Button>
    </div>
  );
}

export function Toolbar(props: ToolbarProps) {
  const {
    running,
    viewer,
    onLaunchViewer,
    onInstallCa,
    decode,
    onToggleDecode,
    onOpenSettings,
    onOpen,
    onSaveSession,
    onClear,
    filter,
    onFilterChange,
    onSaveFilter,
    filterInputRef,
  } = props;

  return (
    <header className="toolbar">
      <div className="brand">
        <span className={`dot ${running && !viewer ? "on" : ""}`} />
        Germi
      </div>

      {viewer ? (
        <div
          className="viewer-badge"
          title="Proxy disabled — this instance only inspects saved captures"
        >
          <IconViewer /> Viewer mode
        </div>
      ) : (
        <ProxyControls {...props} />
      )}

      <div className="tb-sep" />

      <div className="tb-group" role="group" aria-label="Session">
        <Button
          variant="ghost"
          onClick={onOpen}
          title="Open a HAR or Fiddler SAZ archive (replaces current traffic)"
        >
          <IconOpen /> Open
        </Button>
        <Button
          variant="ghost"
          onClick={onSaveSession}
          title="Save current traffic as a HAR archive"
        >
          <IconSave /> Save
        </Button>
        <Button variant="ghost" danger onClick={onClear} title="Clear captured traffic">
          <IconClear /> Clear
        </Button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group" role="group" aria-label="View">
        <Button
          variant={decode ? "default" : "ghost"}
          active={decode}
          onClick={onToggleDecode}
          title="Decompress gzip / brotli / deflate response bodies"
        >
          Decode
        </Button>
        <Button variant="ghost" onClick={onInstallCa} title="Trust the Germi root CA for HTTPS">
          <IconCert /> CA cert
        </Button>
        <Button
          variant="ghost"
          onClick={onLaunchViewer}
          title="Open a second, proxy-less Germi window for inspecting saved captures"
        >
          <IconViewer /> New viewer
        </Button>
        <Button
          variant="ghost"
          onClick={onOpenSettings}
          title="Settings — connections, certificates, interception, capture"
        >
          <IconSettings /> Settings
        </Button>
      </div>

      <div className="spacer" />

      <div className="filter-wrap">
        <input
          ref={filterInputRef}
          className="filter"
          placeholder="Filter — host: status:4xx kind:xhr body:… header:… -negate /regex/"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onSaveFilter();
            }
          }}
          title="Tokens: host: path: method: scheme: status: (4xx, >=400) mime: kind: ext: is:imported is:captured rule: larger-than: slower-than: body: req-body: resp-body: header: req-header: resp-header: — bare words match the URL, /regex/ for regex, leading - negates. Ctrl/⌘ Enter saves the filter."
        />
        {filter && (
          <IconButton
            className="filter-clear"
            label="Clear filter"
            onClick={() => onFilterChange("")}
          >
            <IconClose />
          </IconButton>
        )}
      </div>
      <FilterHelp filter={filter} onPick={onFilterChange} inputRef={filterInputRef} />
    </header>
  );
}
