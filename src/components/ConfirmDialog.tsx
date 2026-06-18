import { useRef } from "react";

import { useModalDialog } from "./useModalDialog";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const confirmed = useRef(false);
  const ref = useModalDialog(() => {
    if (!confirmed.current) onCancel();
  });

  return (
    <dialog ref={ref} className="modal confirm-modal" aria-labelledby="confirm-title">
      <h3 id="confirm-title">{title}</h3>
      <p className="muted">{message}</p>
      <div className="modal-foot">
        <button className="btn" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          className={danger ? "btn danger" : "btn primary"}
          onClick={() => {
            confirmed.current = true;
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
