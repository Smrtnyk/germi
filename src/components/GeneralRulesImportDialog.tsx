import { useId, useRef, useState } from "react";

import type { GeneralRulesImportMode, ScenarioPreview } from "../types";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface Props {
  previews: ScenarioPreview[];
  existingGeneralRuleCount: number;
  /** Whether ordinary scenarios from the file replace rather than append. */
  replaceScenarios: boolean;
  onConfirm: (mode: GeneralRulesImportMode) => void;
  onCancel: () => void;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Three-way issue #122 decision for a bundle carrying the built-in General
 * layer. Merge is the safe intent-preserving default: it keeps existing rules,
 * while replace and legacy "ordinary scenario" behavior remain explicit. */
export function GeneralRulesImportDialog({
  previews,
  existingGeneralRuleCount,
  replaceScenarios,
  onConfirm,
  onCancel,
}: Props) {
  const confirmed = useRef(false);
  const radioName = useId();
  const [mode, setMode] = useState<GeneralRulesImportMode>("merge");
  const generalRuleCount = previews
    .filter((preview) => preview.isGeneral)
    .reduce((count, preview) => count + preview.ruleCount, 0);
  const regularScenarioCount = previews.filter((preview) => !preview.isGeneral).length;

  const options: Array<{
    mode: GeneralRulesImportMode;
    label: string;
    detail: string;
  }> = [
    {
      mode: "merge",
      label: "Merge into General",
      detail: `Add ${plural(generalRuleCount, "imported rule")} after your ${plural(existingGeneralRuleCount, "existing General rule")}.`,
    },
    {
      mode: "replace",
      label: "Replace General",
      detail: `Remove your ${plural(existingGeneralRuleCount, "existing General rule")} and use the ${plural(generalRuleCount, "imported rule")} instead.`,
    },
    {
      mode: "asScenario",
      label: "Import as a scenario",
      detail: "Leave General unchanged and add these rules as a regular, switchable scenario.",
    },
  ];

  return (
    <Modal
      className="general-rules-import-modal"
      ariaLabelledby="general-rules-import-title"
      onClose={() => {
        if (!confirmed.current) onCancel();
      }}
    >
      {(close) => (
        <>
          <h3 id="general-rules-import-title">Import General rules?</h3>
          <p className="muted">
            This file contains {plural(generalRuleCount, "General rule")}. Choose where those rules
            should go.
          </p>
          <fieldset className="general-rules-import-options">
            <legend className="muted small">General rules destination</legend>
            {options.map((option) => (
              <label className="check-row" key={option.mode}>
                <input
                  type="radio"
                  name={radioName}
                  value={option.mode}
                  checked={mode === option.mode}
                  onChange={() => setMode(option.mode)}
                />
                <span className="general-rules-import-option">
                  <strong>{option.label}</strong>
                  <span className="muted small">{option.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {regularScenarioCount > 0 && (
            <p className="muted small general-rules-import-note">
              The file's {plural(regularScenarioCount, "other scenario")} will{" "}
              {replaceScenarios
                ? "replace your current regular scenarios."
                : "be added to your current scenarios."}
            </p>
          )}
          <div className="modal-foot">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              danger={mode === "replace"}
              onClick={() => {
                confirmed.current = true;
                onConfirm(mode);
              }}
            >
              Import rules
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
