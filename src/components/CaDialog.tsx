import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { CaInfo } from "../types";
import { useToast } from "../toast";
import { useModalDialog } from "./useModalDialog";

interface Props {
  info: CaInfo;
  onClose: () => void;
}

export function CaDialog({ info, onClose }: Props) {
  const ref = useModalDialog(onClose);
  const notify = useToast();

  const close = () => ref.current?.close();
  const copy = (label: string, value: string) => {
    if (!value) {
      notify("info", `No ${label.toLowerCase()} to copy`);
      return;
    }
    void navigator.clipboard.writeText(value);
    notify("success", `${label} copied`);
  };

  const winCmd = `certutil -addstore -user -f root "${info.certPath}"`;
  const linuxSystemCmd =
    `sudo cp "${info.certPath}" /usr/local/share/ca-certificates/germi-ca.crt\n` +
    "sudo update-ca-certificates";
  const linuxNssCmd = `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Germi CA" -i "${info.certPath}"`;

  return (
    <dialog ref={ref} className="modal" aria-labelledby="ca-title">
      <div className="modal-head">
        <h3 id="ca-title">Trust the Germi root CA</h3>
        <button className="btn ghost" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>

      <p className="muted">
        HTTPS interception requires this one-time step. The CA private key never leaves your machine
        — but anything that trusts it can be intercepted, so keep it to development machines.
      </p>

      <div className="ca-path">
        <code>{info.certPath}</code>
        <button className="btn" onClick={() => copy("Path", info.certPath)}>
          Copy path
        </button>
        <button className="btn" onClick={() => void revealItemInDir(info.certPath)}>
          Reveal
        </button>
      </div>

      <h4>Windows</h4>
      <div className="snippet-wrap">
        <pre className="snippet">{winCmd}</pre>
        <button
          className="btn small snippet-copy"
          title="Copy command"
          aria-label="Copy Windows command"
          onClick={() => copy("Command", winCmd)}
        >
          ⧉ Copy
        </button>
      </div>
      <p className="muted small">
        Adds it to the current-user Trusted Root store (no admin needed).
      </p>

      <h4>Linux — system store (curl, wget, most CLIs)</h4>
      <div className="snippet-wrap">
        <pre className="snippet">{linuxSystemCmd}</pre>
        <button
          className="btn small snippet-copy"
          title="Copy command"
          aria-label="Copy Linux system-store command"
          onClick={() => copy("Command", linuxSystemCmd)}
        >
          ⧉ Copy
        </button>
      </div>

      <h4>Linux — Chrome / Firefox (own NSS store)</h4>
      <div className="snippet-wrap">
        <pre className="snippet">{linuxNssCmd}</pre>
        <button
          className="btn small snippet-copy"
          title="Copy command"
          aria-label="Copy Linux NSS command"
          onClick={() => copy("Command", linuxNssCmd)}
        >
          ⧉ Copy
        </button>
      </div>
      <p className="muted small">
        Requires <code>libnss3-tools</code>. Repeat per Firefox profile under{" "}
        <code>~/.mozilla/firefox/*</code>.
      </p>

      <div className="modal-foot">
        <button className="btn" onClick={() => copy("PEM", info.certPem)}>
          Copy PEM
        </button>
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
