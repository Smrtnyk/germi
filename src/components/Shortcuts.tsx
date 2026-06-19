import { useModalDialog } from "./useModalDialog";

const GROUPS: { title: string; rows: { keys: string; desc: string }[] }[] = [
  {
    title: "Global",
    rows: [
      { keys: "Ctrl / ⌘ K", desc: "Open command palette" },
      { keys: "?", desc: "Show this shortcuts help" },
      { keys: "Ctrl / ⌘ S", desc: "Save session" },
      { keys: "Ctrl / ⌘ O", desc: "Open session" },
    ],
  },
  {
    title: "Traffic",
    rows: [
      { keys: "/   ·   Ctrl / ⌘ F", desc: "Focus the filter" },
      { keys: "↑ ↓   ·   j k", desc: "Move selection" },
      { keys: "Shift + ↑ / ↓", desc: "Extend selection" },
      { keys: "Ctrl / ⌘ A", desc: "Select all (filtered) flows" },
      { keys: "Home / End", desc: "Jump to first / last flow" },
      { keys: "Esc", desc: "Clear selection" },
      { keys: "Delete / Backspace", desc: "Delete selected requests" },
      { keys: "Right-click", desc: "Row actions (mock, copy, filter…)" },
    ],
  },
  {
    title: "Panels",
    rows: [
      { keys: "Ctrl / ⌘ 1", desc: "Show Inspector" },
      { keys: "Ctrl / ⌘ 2", desc: "Show Autoresponder" },
    ],
  },
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const ref = useModalDialog(onClose);
  return (
    <dialog ref={ref} className="modal shortcuts-modal" aria-labelledby="shortcuts-title">
      <div className="modal-head">
        <h3 id="shortcuts-title">Keyboard shortcuts</h3>
        <button className="btn ghost" onClick={() => ref.current?.close()} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="shortcuts-grid">
        {GROUPS.map((g) => (
          <div className="shortcuts-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.rows.map((r) => (
              <div className="shortcuts-row" key={r.desc}>
                <kbd>{r.keys}</kbd>
                <span>{r.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="muted small">
        Tip: <kbd>Ctrl / ⌘ K</kbd> opens the command palette for every action.
      </p>
    </dialog>
  );
}
