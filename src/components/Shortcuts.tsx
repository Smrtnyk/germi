import { prettyShortcut, type Bindings } from "../shortcuts";
import { useModalDialog } from "./useModalDialog";

/** The configurable rows pull their keys from `bindings`; the rest (list
 *  navigation, undo/redo, the `/` and `?` aliases) are fixed and stay literal. */
function buildGroups(b: Bindings): { title: string; rows: { keys: string; desc: string }[] }[] {
  return [
    {
      title: "Global",
      rows: [
        { keys: prettyShortcut(b.palette), desc: "Open command palette" },
        { keys: "?", desc: "Show this shortcuts help" },
        { keys: prettyShortcut(b.save), desc: "Save session" },
        { keys: prettyShortcut(b.open), desc: "Open session" },
      ],
    },
    {
      title: "Traffic",
      rows: [
        { keys: "/", desc: "Focus the filter" },
        {
          keys: prettyShortcut(b["focus-filter"]),
          desc: "Find in the open request, else focus the filter",
        },
        { keys: "F3   ·   Shift + F3", desc: "Next / previous find match" },
        { keys: "↑ ↓   ·   j k", desc: "Move selection" },
        { keys: "Shift + ↑ / ↓", desc: "Extend selection" },
        { keys: "Ctrl / ⌘ A", desc: "Select all (filtered) flows" },
        { keys: "Ctrl / ⌘ + click", desc: "Add / remove a row from selection" },
        { keys: "Home / End", desc: "Jump to first / last flow" },
        { keys: "Esc", desc: "Clear selection" },
        { keys: "Delete / Backspace", desc: "Delete selected requests" },
        { keys: prettyShortcut(b["copy-url"]), desc: "Copy URL of selected request" },
        { keys: "Right-click", desc: "Row actions (mock, copy, filter…)" },
      ],
    },
    {
      title: "Panels",
      rows: [
        { keys: prettyShortcut(b["show-inspector"]), desc: "Show Inspector" },
        { keys: prettyShortcut(b["show-autoresponder"]), desc: "Show Autoresponder" },
        { keys: prettyShortcut(b["edit-mock-body"]), desc: "Edit mock response body" },
      ],
    },
  ];
}

export function Shortcuts({ bindings, onClose }: { bindings: Bindings; onClose: () => void }) {
  const ref = useModalDialog(onClose);
  const groups = buildGroups(bindings);
  return (
    <dialog ref={ref} className="modal shortcuts-modal" aria-labelledby="shortcuts-title">
      <div className="modal-head">
        <h3 id="shortcuts-title">Keyboard shortcuts</h3>
        <button className="btn ghost" onClick={() => ref.current?.close()} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="shortcuts-grid">
        {groups.map((g) => (
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
        Tip: <kbd>{prettyShortcut(bindings.palette)}</kbd> opens the command palette for every
        action. Rebind these under Settings → Shortcuts.
      </p>
    </dialog>
  );
}
