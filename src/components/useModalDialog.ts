import { useEffect, useRef } from "react";

export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    dlg.setAttribute("closedby", "any");
    if (!dlg.open) dlg.showModal();

    const handleClose = () => onClose();
    const handleClick = (event: MouseEvent) => {
      if (event.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside =
        r.top <= event.clientY &&
        event.clientY <= r.top + r.height &&
        r.left <= event.clientX &&
        event.clientX <= r.left + r.width;
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

  return ref;
}
