import { useRef } from "react";

import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

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

  return (
    <Modal
      className="confirm-modal"
      ariaLabelledby="confirm-title"
      onClose={() => {
        if (!confirmed.current) onCancel();
      }}
    >
      {(close) => (
        <>
          <h3 id="confirm-title">{title}</h3>
          <p className="muted">{message}</p>
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant={danger ? "default" : "primary"}
              danger={danger}
              onClick={() => {
                confirmed.current = true;
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
