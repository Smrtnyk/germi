interface Props {
  running: boolean;
  port: number;
  flowCount: number;
  activeScenario: string | null;
}

export function StatusBar({ running, port, flowCount, activeScenario }: Props) {
  return (
    <footer className="statusbar">
      <span className={`stat ${running ? "on" : "off"}`}>
        <span className="led" />
        {running ? `Listening on 127.0.0.1:${port}` : "Stopped"}
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
