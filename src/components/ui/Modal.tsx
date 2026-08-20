import type { ReactNode } from "react";

import { useModalDialog } from "../useModalDialog";

interface ModalProps {
  /** Fired when the dialog closes (Escape, an enabled backdrop click, or `close()`). */
  onClose: () => void;
  /** Extra class alongside the base `.modal` (e.g. `settings-modal`). */
  className?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  /** Prevent user dismissal while an async action is pending. */
  dismissible?: boolean;
  /** Whether clicking the backdrop closes the dialog. Escape remains controlled
   *  independently by `dismissible`. */
  backdropDismissible?: boolean;
  /** Policy for native close requests such as Escape. Return `false` to
   *  intercept the request before the dialog closes. Imperative `close()`
   *  actions, including explicit Cancel buttons, bypass this policy. */
  shouldCloseOnRequest?: () => boolean;
  /** Static content, or a render function receiving `close()` to dismiss the
   *  dialog imperatively (e.g. a Cancel button). */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** The shared modal shell: owns the native `<dialog>` + `useModalDialog`
 *  (showModal and configured close behavior) and the `.modal` chrome, so every
 *  dialog gets identical framing and predictable dismissal semantics. */
export function Modal({
  onClose,
  className,
  ariaLabel,
  ariaLabelledby,
  dismissible = true,
  backdropDismissible = false,
  shouldCloseOnRequest,
  children,
}: ModalProps) {
  const ref = useModalDialog(onClose, dismissible, backdropDismissible, shouldCloseOnRequest);
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
