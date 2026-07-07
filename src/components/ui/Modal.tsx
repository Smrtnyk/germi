import type { ReactNode } from "react";

import { useModalDialog } from "../useModalDialog";

interface ModalProps {
  /** Fired when the dialog closes (Escape, backdrop click, or `close()`). */
  onClose: () => void;
  /** Extra class alongside the base `.modal` (e.g. `settings-modal`). */
  className?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  /** Static content, or a render function receiving `close()` to dismiss the
   *  dialog imperatively (e.g. a Cancel button). */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** The shared modal shell: owns the native `<dialog>` + `useModalDialog`
 *  (showModal, Escape / backdrop-click to close) and the `.modal` chrome, so
 *  every dialog gets identical open/close behavior and framing. */
export function Modal({ onClose, className, ariaLabel, ariaLabelledby, children }: ModalProps) {
  const ref = useModalDialog(onClose);
  const close = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : "modal"}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
    >
      {typeof children === "function" ? children(close) : children}
    </dialog>
  );
}
