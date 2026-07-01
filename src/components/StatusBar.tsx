interface Props {
  running: boolean;
  port: number;
  /** When the proxy is bound to 0.0.0.0 (LAN-reachable) rather than loopback. */
  allowRemote: boolean;
  /** Viewer mode (`--viewer`): no proxy, so show a viewer state instead. */
  viewer: boolean;
  flowCount: number;
  activeScenario: string | null;
  onOpenPalette: () => void;
  onShowShortcuts: () => void;
  /** Pretty label of the configurable command-palette shortcut, for the tooltip. */
  paletteAccel: string;
}

export function StatusBar({
  running,
  port,
  allowRemote,
  viewer,
  flowCount,
  activeScenario,
  onOpenPalette,
  onShowShortcuts,
  paletteAccel,
}: Props) {
  const host = allowRemote ? "0.0.0.0" : "127.0.0.1";
  return (
    <footer className="statusbar">
      {viewer ? (
        <span className="stat viewer" title="Proxy disabled — inspecting saved captures only">
          <span className="led" />
          Viewer mode
        </span>
      ) : (
        <span className={`stat ${running ? "on" : "off"}`}>
          <span className="led" />
          {running ? `Listening on ${host}:${port}` : "Stopped"}
        </span>
      )}
      <span className="sep">·</span>
      <span>{flowCount} flows</span>
      <span className="spacer" />
      <span>
        Autoresponder:{" "}
        {activeScenario ? (
          <strong className="scenario-live">{activeScenario}</strong>
        ) : (
          <span className="muted">Off</span>
        )}
      </span>
      <span className="sep">·</span>
      <button
        className="status-key"
        onClick={onOpenPalette}
        title={`Command palette (${paletteAccel})`}
      >
        ⌘K
      </button>
      <button className="status-key" onClick={onShowShortcuts} title="Keyboard shortcuts (?)">
        ?
      </button>
    </footer>
  );
}
