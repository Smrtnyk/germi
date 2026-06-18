interface Props {
  running: boolean;
  port: number;
  /** When the proxy is bound to 0.0.0.0 (LAN-reachable) rather than loopback. */
  allowRemote: boolean;
  flowCount: number;
  activeScenario: string | null;
}

export function StatusBar({ running, port, allowRemote, flowCount, activeScenario }: Props) {
  const host = allowRemote ? "0.0.0.0" : "127.0.0.1";
  return (
    <footer className="statusbar">
      <span className={`stat ${running ? "on" : "off"}`}>
        <span className="led" />
        {running ? `Listening on ${host}:${port}` : "Stopped"}
      </span>
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
    </footer>
  );
}
