import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { CaInfo } from "../types";
import { useCopy } from "../useCopy";
import { IconClose, IconCopy } from "./icons";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface Props {
  info: CaInfo;
  onClose: () => void;
}

export function CaDialog({ info, onClose }: Props) {
  const copy = useCopy();

  const winCmd = `certutil -addstore -user -f root "${info.certPath}"`;
  const linuxSystemCmd =
    `sudo cp "${info.certPath}" /usr/local/share/ca-certificates/germi-ca.crt\n` +
    "sudo update-ca-certificates";
  const linuxNssCmd = `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Germi CA" -i "${info.certPath}"`;

  return (
    <Modal onClose={onClose} ariaLabelledby="ca-title">
      {(close) => (
        <>
          <div className="modal-head">
            <h3 id="ca-title">Trust the Germi root CA</h3>
            <Button variant="ghost" onClick={close} aria-label="Close">
              <IconClose />
            </Button>
          </div>

          <p className="muted">
            HTTPS interception requires this one-time step. The CA private key never leaves your
            machine — but anything that trusts it can be intercepted, so keep it to development
            machines.
          </p>

          <div className="ca-path">
            <code>{info.certPath}</code>
            <Button onClick={() => copy("Path", info.certPath)}>Copy path</Button>
            <Button onClick={() => void revealItemInDir(info.certPath)}>Reveal</Button>
          </div>

          <h4>Windows</h4>
          <div className="snippet-wrap">
            <pre className="snippet">{winCmd}</pre>
            <Button
              size="small"
              className="snippet-copy"
              title="Copy command"
              aria-label="Copy Windows command"
              onClick={() => copy("Command", winCmd)}
            >
              <IconCopy /> Copy
            </Button>
          </div>
          <p className="muted small">
            Adds it to the current-user Trusted Root store (no admin needed).
          </p>

          <h4>Linux — system store (curl, wget, most CLIs)</h4>
          <div className="snippet-wrap">
            <pre className="snippet">{linuxSystemCmd}</pre>
            <Button
              size="small"
              className="snippet-copy"
              title="Copy command"
              aria-label="Copy Linux system-store command"
              onClick={() => copy("Command", linuxSystemCmd)}
            >
              <IconCopy /> Copy
            </Button>
          </div>

          <h4>Linux — Chrome / Firefox (own NSS store)</h4>
          <div className="snippet-wrap">
            <pre className="snippet">{linuxNssCmd}</pre>
            <Button
              size="small"
              className="snippet-copy"
              title="Copy command"
              aria-label="Copy Linux NSS command"
              onClick={() => copy("Command", linuxNssCmd)}
            >
              <IconCopy /> Copy
            </Button>
          </div>
          <p className="muted small">
            Requires <code>libnss3-tools</code>. Repeat per Firefox profile under{" "}
            <code>~/.mozilla/firefox/*</code>.
          </p>

          <div className="modal-foot">
            <Button onClick={() => copy("PEM", info.certPem)}>Copy PEM</Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
