import { useState } from "react";

import type { ToastRecord } from "../toast";
import { IconBell } from "./icons";
import { NotificationHistoryDialog } from "./NotificationHistoryDialog";

interface NotificationCenterProps {
  history: readonly ToastRecord[];
  unreadCount: number;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onClear: () => void;
}

interface Props {
  running: boolean;
  port: number;
  /** When the proxy is bound to 0.0.0.0 (LAN-reachable) rather than loopback. */
  allowRemote: boolean;
  /** Viewer mode (`--viewer`): no proxy, so show a viewer state instead. */
  viewer: boolean;
  flowCount: number;
  activeScenario: string | null;
  /** Whether the built-in General rules layer is on (stacks on the active scenario). */
  generalActive: boolean;
  onOpenPalette: () => void;
  onShowShortcuts: () => void;
  notifications: NotificationCenterProps;
  /** Pretty label of the configurable command-palette shortcut, for the tooltip. */
  paletteAccel: string;
}

function NotificationBell({ unreadCount, onOpen }: { unreadCount: number; onOpen: () => void }) {
  const suffix = unreadCount > 0 ? `, ${unreadCount} unread` : "";
  const title =
    unreadCount > 0
      ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
      : "Notifications";
  return (
    <button
      className="status-key notification-bell"
      onClick={onOpen}
      aria-label={`Notifications${suffix}`}
      title={title}
    >
      <IconBell />
      {unreadCount > 0 && <span className="notification-badge">{Math.min(unreadCount, 99)}</span>}
    </button>
  );
}

function NotificationCenter(props: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <NotificationBell unreadCount={props.unreadCount} onOpen={() => setOpen(true)} />
      {open && (
        <NotificationHistoryDialog
          history={props.history}
          unreadCount={props.unreadCount}
          onMarkRead={props.onMarkRead}
          onMarkAllRead={props.onMarkAllRead}
          onClear={props.onClear}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** What the autoresponder is doing: the active scenario, the General layer, both
 *  (stacked), or Off. General on with no active scenario is NOT "Off" — the
 *  General rules still apply, so it's surfaced in its place. */
function AutoresponderStatus({
  activeScenario,
  generalActive,
}: {
  activeScenario: string | null;
  generalActive: boolean;
}) {
  if (!activeScenario && !generalActive) {
    return <span className="muted">Off</span>;
  }
  return (
    <>
      {activeScenario && <strong className="scenario-live">{activeScenario}</strong>}
      {activeScenario && generalActive && " + "}
      {generalActive && <strong className="scenario-live">General rules</strong>}
    </>
  );
}

export function StatusBar({
  running,
  port,
  allowRemote,
  viewer,
  flowCount,
  activeScenario,
  generalActive,
  onOpenPalette,
  onShowShortcuts,
  notifications,
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
      {/* The autoresponder is disabled in viewer mode (no proxy to mock). */}
      {!viewer && (
        <>
          <span>
            Autoresponder:{" "}
            <AutoresponderStatus activeScenario={activeScenario} generalActive={generalActive} />
          </span>
          <span className="sep">·</span>
        </>
      )}
      <NotificationCenter {...notifications} />
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
