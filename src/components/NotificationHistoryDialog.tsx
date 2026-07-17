import type { ToastRecord } from "../toast";
import { ToastKindIcon } from "../toast";
import { IconClose } from "./icons";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Modal } from "./ui/Modal";

interface Props {
  history: readonly ToastRecord[];
  unreadCount: number;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onClear: () => void;
  onClose: () => void;
}

export function NotificationHistoryDialog({
  history,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
  onClear,
  onClose,
}: Props) {
  return (
    <Modal
      className="notification-history-modal"
      ariaLabelledby="notifications-title"
      onClose={onClose}
    >
      {(close) => (
        <>
          <div className="notification-history-head">
            <div>
              <h3 id="notifications-title">Notifications</h3>
              <p className="muted small">Messages from this Germi session</p>
            </div>
            <IconButton label="Close notifications" onClick={close}>
              <IconClose />
            </IconButton>
          </div>

          <div className="notification-history-actions">
            <Button size="small" onClick={onMarkAllRead} disabled={unreadCount === 0}>
              Mark all read
            </Button>
            <Button size="small" danger onClick={onClear} disabled={history.length === 0}>
              Clear all
            </Button>
          </div>

          {history.length === 0 ? (
            <p className="notification-history-empty muted">No notifications this session.</p>
          ) : (
            <ul className="notification-history-list">
              {history.map((item) => (
                <li
                  key={item.id}
                  className={`notification-history-item ${item.kind} ${
                    item.read ? "read" : "unread"
                  }`}
                >
                  <ToastKindIcon kind={item.kind} />
                  <span className="notification-history-message">{item.message}</span>
                  {item.read ? (
                    <span className="muted small">Read</span>
                  ) : (
                    <Button size="small" onClick={() => onMarkRead(item.id)}>
                      Mark read
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
