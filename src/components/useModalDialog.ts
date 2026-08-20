import { useEffect, useRef } from "react";

export function useModalDialog(
  onClose: () => void,
  dismissible = true,
  backdropDismissible = false,
  shouldCloseOnRequest?: () => boolean,
) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const backdropDismissibleRef = useRef(backdropDismissible);
  const shouldCloseOnRequestRef = useRef(shouldCloseOnRequest);
  onCloseRef.current = onClose;
  dismissibleRef.current = dismissible;
  backdropDismissibleRef.current = backdropDismissible;
  shouldCloseOnRequestRef.current = shouldCloseOnRequest;

  useEffect(() => {
    ref.current?.setAttribute(
      "closedby",
      !dismissible ? "none" : backdropDismissible ? "any" : "closerequest",
    );
  }, [backdropDismissible, dismissible]);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();

    const handleClose = () => onCloseRef.current();
    const handleCancel = (event: Event) => {
      if (!dismissibleRef.current) {
        event.preventDefault();
        return;
      }
      if (shouldCloseOnRequestRef.current?.() === false) event.preventDefault();
    };
    const handleClick = (event: MouseEvent) => {
      if (!dismissibleRef.current || !backdropDismissibleRef.current || event.target !== dlg)
        return;
      const r = dlg.getBoundingClientRect();
      const inside =
        r.top <= event.clientY &&
        event.clientY <= r.top + r.height &&
        r.left <= event.clientX &&
        event.clientX <= r.left + r.width;
      if (!inside) dlg.close();
    };

    dlg.addEventListener("close", handleClose);
    dlg.addEventListener("cancel", handleCancel);
    dlg.addEventListener("click", handleClick);
    return () => {
      dlg.removeEventListener("close", handleClose);
      dlg.removeEventListener("cancel", handleCancel);
      dlg.removeEventListener("click", handleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}
