import { useEffect, useMemo, useRef, useState } from "react";

import { useModalDialog } from "./useModalDialog";

export interface PaletteAction {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const ref = useModalDialog(onClose);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = actions.filter((a) => !a.disabled);
    if (!s) return base;
    return base.filter((a) => `${a.group ?? ""} ${a.label}`.toLowerCase().includes(s));
  }, [q, actions]);

  useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered, idx]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function run(a: PaletteAction) {
    onClose();
    a.run();
  }

  return (
    <dialog ref={ref} className="modal palette-modal" aria-label="Command palette">
      <input
        autoFocus
        className="palette-input"
        placeholder="Type a command…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIdx((i) => Math.min(filtered.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const a = filtered[idx];
            if (a) run(a);
          }
        }}
      />
      <div className="palette-list" ref={listRef}>
        {filtered.length === 0 && <div className="muted pad small">No matching commands</div>}
        {filtered.map((a, i) => (
          <button
            key={a.id}
            className={`palette-item ${i === idx ? "on" : ""}`}
            onMouseMove={() => setIdx(i)}
            onClick={() => run(a)}
          >
            <span className="pi-label">
              {a.group && <span className="pi-group">{a.group}</span>}
              {a.label}
            </span>
            {a.shortcut && <kbd>{a.shortcut}</kbd>}
          </button>
        ))}
      </div>
    </dialog>
  );
}
