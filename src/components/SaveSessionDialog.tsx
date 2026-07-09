import { useRef, useState } from "react";

import { loadBool, persist } from "../localStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface Props {
  ruleCount: number;
  onSave: (includeRules: boolean) => void;
  onCancel: () => void;
}

/** Pre-save options for the HAR export, shown only when mock rules are
 *  currently shaping traffic: opt into embedding them as the `_germiRules`
 *  extension field (issue #113). Off by default — rule bodies can carry
 *  secrets — and the choice is remembered. Prop-driven and IPC-free so it
 *  stays browser-testable. */
export function SaveSessionDialog({ ruleCount, onSave, onCancel }: Props) {
  const confirmed = useRef(false);
  const [includeRules, setIncludeRules] = useState(() => loadBool("germi.har.includeRules", false));

  return (
    <Modal
      className="confirm-modal"
      ariaLabelledby="save-session-title"
      onClose={() => {
        if (!confirmed.current) onCancel();
      }}
    >
      {(close) => (
        <>
          <h3 id="save-session-title">Save session as HAR</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeRules}
              onChange={(e) => {
                setIncludeRules(e.target.checked);
                persist("germi.har.includeRules", e.target.checked ? "1" : "0");
              }}
            />
            <span>
              Include mock rules ({ruleCount} rule{ruleCount === 1 ? "" : "s"} currently mocking)
            </span>
          </label>
          <p className="muted">
            Rules ride in a Germi-only field that other HAR tools ignore; opening the file in Germi
            offers to import them.
          </p>
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                confirmed.current = true;
                onSave(includeRules);
              }}
            >
              Save…
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
