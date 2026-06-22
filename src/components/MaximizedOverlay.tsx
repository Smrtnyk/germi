import type { ReactNode } from "react";

import { useModalDialog } from "./useModalDialog";

/**
 * Full-viewport modal that enlarges a body view (inspector or rule editor).
 * Built on the native <dialog> via useModalDialog, so Escape and clicking the
 * backdrop both close it; the header also carries an explicit Restore button.
 */
export function MaximizedOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useModalDialog(onClose);
  return (
    <dialog ref={ref} className="maximize-dialog">
      <div className="maximize-head">
        <span className="maximize-title">{title}</span>
        <button className="btn ghost small" title="Restore (Esc)" onClick={onClose}>
          ⤡ Restore
        </button>
      </div>
      <div className="maximize-content">{children}</div>
    </dialog>
  );
}
