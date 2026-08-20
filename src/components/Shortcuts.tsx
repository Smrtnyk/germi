import { prettyShortcut, type Bindings } from "../shortcuts";
import { RESOURCE_TYPE_META } from "../resourceType";
import { IconClose, IconResourceType } from "./icons";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

/** The configurable rows pull their keys from `bindings`; the rest (list
 *  navigation, undo/redo, the `/` and `?` aliases) are fixed and stay literal. */
function buildGroups(b: Bindings): { title: string; rows: { keys: string; desc: string }[] }[] {
  return [
    {
      title: "Global",
      rows: [
        { keys: prettyShortcut(b.palette), desc: "Open command palette" },
        { keys: "?", desc: "Show help" },
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
        {
          keys: prettyShortcut(b["toggle-filter-hide"]),
          desc: "Hide / dim non-matching requests",
        },
        { keys: "Ctrl / ⌘ Enter", desc: "Save the filter bar as a saved filter (in the bar)" },
        { keys: "F3   ·   Shift + F3", desc: "Next / previous find match" },
        { keys: "↑ ↓   ·   j k", desc: "Move selection" },
        { keys: "Shift + ↑ / ↓", desc: "Extend selection" },
        {
          keys: "Ctrl / ⌘ A",
          desc: "Select all (filtered) flows when the traffic list is focused",
        },
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
        { keys: prettyShortcut(b["show-filters"]), desc: "Show saved Filters" },
        { keys: prettyShortcut(b["edit-mock-body"]), desc: "Edit mock response body" },
      ],
    },
  ];
}

type ShortcutGroup = ReturnType<typeof buildGroups>[number];

function ShortcutSection({ group }: { group: ShortcutGroup }) {
  return (
    <div className="shortcuts-group">
      <h4>{group.title}</h4>
      {group.rows.map((row) => (
        <div className="shortcuts-row" key={row.desc}>
          <kbd>{row.keys}</kbd>
          <span>{row.desc}</span>
        </div>
      ))}
    </div>
  );
}

export function Shortcuts({ bindings, onClose }: { bindings: Bindings; onClose: () => void }) {
  const [globalGroup, trafficGroup, panelsGroup] = buildGroups(bindings);
  return (
    <Modal className="shortcuts-modal" ariaLabelledby="shortcuts-title" onClose={onClose}>
      {(close) => (
        <>
          <div className="modal-head">
            <h3 id="shortcuts-title">Help</h3>
            <Button variant="ghost" onClick={close} aria-label="Close">
              <IconClose />
            </Button>
          </div>
          <h4 className="help-section-title">Keyboard shortcuts</h4>
          <div className="shortcuts-grid">
            <div className="shortcuts-column">
              <ShortcutSection group={globalGroup} />
              <ShortcutSection group={panelsGroup} />
            </div>
            <div className="shortcuts-column">
              <ShortcutSection group={trafficGroup} />
            </div>
          </div>
          <section className="resource-legend" aria-labelledby="resource-legend-title">
            <h4 id="resource-legend-title">Resource icons</h4>
            <div className="resource-legend-grid">
              {RESOURCE_TYPE_META.map(({ type, label }) => (
                <div className="resource-legend-item" key={type}>
                  <IconResourceType resourceType={type} decorative />
                  <span className="resource-legend-label">{label}</span>
                </div>
              ))}
            </div>
          </section>
          <p className="muted small">
            Tip: <kbd>{prettyShortcut(bindings.palette)}</kbd> opens the command palette for every
            action. Rebind these under Settings → Shortcuts.
          </p>
        </>
      )}
    </Modal>
  );
}
