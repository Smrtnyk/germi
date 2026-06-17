import { useEffect, useRef } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small native-<dialog> confirmation. Escape / click-outside / Cancel abort. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    dlg.setAttribute("closedby", "any");
    if (!dlg.open) dlg.showModal();

    const handleClose = () => {
      if (!confirmed.current) onCancel();
    };
    const handleClick = (e: MouseEvent) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside =
        r.top <= e.clientY &&
        e.clientY <= r.top + r.height &&
        r.left <= e.clientX &&
        e.clientX <= r.left + r.width;
      if (!inside) dlg.close();
    };
    dlg.addEventListener("close", handleClose);
    dlg.addEventListener("click", handleClick);
    return () => {
      dlg.removeEventListener("close", handleClose);
      dlg.removeEventListener("click", handleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
