import { useRef, useState } from "react";

import type { SettingsSectionSummary } from "../types";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface Props {
  title: string;
  message: string;
  sections: SettingsSectionSummary[];
  confirmLabel: string;
  onConfirm: (sectionIds: string[]) => void;
  onCancel: () => void;
}

/** Checklist over settings sections, shared by partial export ("what goes into
 *  the file") and import preview ("this is what the file carries — pick what to
 *  apply"). Everything starts checked; confirm is disabled with nothing picked
 *  (issue #112). Prop-driven and IPC-free so it stays browser-testable. */
export function SettingsSectionsDialog({
  title,
  message,
  sections,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const confirmed = useRef(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(sections.map((s) => s.id)),
  );

  function toggle(id: string) {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal
      className="sections-modal"
      ariaLabelledby="sections-title"
      onClose={() => {
        if (!confirmed.current) onCancel();
      }}
    >
      {(close) => (
        <>
          <h3 id="sections-title">{title}</h3>
          <p className="muted">{message}</p>
          <div className="sections-all">
            <Button size="small" onClick={() => setChecked(new Set(sections.map((s) => s.id)))}>
              All
            </Button>
            <Button size="small" onClick={() => setChecked(new Set())}>
              None
            </Button>
          </div>
          <ul className="sections-list">
            {sections.map((s) => (
              <li key={s.id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={checked.has(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="section-label">{s.label}</span>
                  <span className="muted small section-detail">{s.detail}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={checked.size === 0}
              onClick={() => {
                confirmed.current = true;
                onConfirm(sections.map((s) => s.id).filter((id) => checked.has(id)));
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
