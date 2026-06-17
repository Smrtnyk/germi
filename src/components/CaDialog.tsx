import { useEffect, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { CaInfo } from "../types";

interface Props {
  info: CaInfo;
  onClose: () => void;
}

export function CaDialog({ info, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    dlg.setAttribute("closedby", "any"); // native light-dismiss where supported
    if (!dlg.open) dlg.showModal(); // top layer + focus trap + native Esc

    const handleClose = () => onClose();
    // Light-dismiss fallback for engines without <dialog closedby> (WebKitGTK).
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

  const close = () => ref.current?.close();
  const copy = (text: string) => void navigator.clipboard.writeText(text);

  return (
    <dialog ref={ref} className="modal" aria-labelledby="ca-title">
      <div className="modal-head">
        <h3 id="ca-title">Trust the Germi root CA</h3>
        <button className="btn ghost" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>

      <p className="muted">
        HTTPS interception requires this one-time step. The CA private key never
        leaves your machine — but anything that trusts it can be intercepted, so
        keep it to development machines.
      </p>

      <div className="ca-path">
        <code>{info.certPath}</code>
        <button className="btn" onClick={() => copy(info.certPath)}>
          Copy path
        </button>
        <button className="btn" onClick={() => void revealItemInDir(info.certPath)}>
          Reveal
        </button>
      </div>

      <h4>Windows</h4>
      <pre className="snippet">certutil -addstore -user -f root "{info.certPath}"</pre>
      <p className="muted small">
        Adds it to the current-user Trusted Root store (no admin needed).
      </p>

      <h4>Linux — system store (curl, wget, most CLIs)</h4>
      <pre className="snippet">
        sudo cp "{info.certPath}" /usr/local/share/ca-certificates/germi-ca.crt
        {"\n"}sudo update-ca-certificates
      </pre>

      <h4>Linux — Chrome / Firefox (own NSS store)</h4>
      <pre className="snippet">
        certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Germi CA" -i "{info.certPath}"
      </pre>
      <p className="muted small">
        Requires <code>libnss3-tools</code>. Repeat per Firefox profile under{" "}
        <code>~/.mozilla/firefox/*</code>.
      </p>

      <div className="modal-foot">
        <button className="btn" onClick={() => copy(info.certPem)}>
          Copy PEM
        </button>
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
