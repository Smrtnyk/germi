import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { CaInfo } from "../types";
import { useModalDialog } from "./useModalDialog";

interface Props {
  info: CaInfo;
  onClose: () => void;
}

export function CaDialog({ info, onClose }: Props) {
  const ref = useModalDialog(onClose);

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
