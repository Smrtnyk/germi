import { useState } from "react";
import { compact } from "es-toolkit";

import type { ProxySettings } from "../types";
import { allColumns, PRESETS } from "../columns";
import { IconArrowDown, IconArrowUp, IconClose } from "./icons";

interface Props {
  order: string[];
  onOrderChange: (order: string[]) => void;
  settings: ProxySettings;
  onSettingsChange: (s: ProxySettings) => void;
}

export function ColumnsSettings({ order, onOrderChange, settings, onSettingsChange }: Props) {
  const [hdr, setHdr] = useState("");
  const [side, setSide] = useState<"resp" | "req">("resp");

  const all = allColumns(settings.headerColumns);
  const byId = new Map(all.map((c) => [c.id, c]));
  const visible = compact(order.map((id) => byId.get(id)));
  const hidden = all.filter((c) => !order.includes(c.id));

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= visible.length) return;
    // Swap the two VISIBLE rows by their real positions in `order`, so an
    // unresolved/stale id sitting in `order` (e.g. a pinned header dropped by an
    // imported/reset settings) can't make the visible index mis-map and swap the
    // wrong columns.
    const a = order.indexOf(visible[i].id);
    const b = order.indexOf(visible[j].id);
    if (a < 0 || b < 0) return;
    const next = [...order];
    [next[a], next[b]] = [next[b], next[a]];
    onOrderChange(next);
  }
  function addHeaderColumn() {
    const name = hdr
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    if (!name) {
      setHdr("");
      return;
    }
    const spec = side === "req" ? `req:${name}` : name;
    const colId = `hdr:${spec}`;
    if (!settings.headerColumns.includes(spec)) {
      onSettingsChange({
        ...settings,
        headerColumns: [...settings.headerColumns, spec],
      });
    }
    if (!order.includes(colId)) onOrderChange([...order, colId]);
    setHdr("");
  }
  function removeHeaderColumn(spec: string) {
    onSettingsChange({
      ...settings,
      headerColumns: settings.headerColumns.filter((s) => s !== spec),
    });
    onOrderChange(order.filter((id) => id !== `hdr:${spec}`));
  }

  return (
    <div className="settings-pane columns-settings">
      <h4>Columns</h4>
      <p className="muted small">
        Choose which columns the traffic list shows and their order. Resize them by dragging the
        header dividers.
      </p>

      <div className="col-presets">
        <span className="muted small">Presets:</span>
        {PRESETS.map((p) => (
          <button key={p.name} className="btn small" onClick={() => onOrderChange(p.columns)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="col-section-label">Shown</div>
      <ul className="col-list">
        {visible.map((c, i) => (
          <li key={c.id}>
            <span className="col-name">{c.label}</span>
            <span className="col-actions">
              <button className="x" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <IconArrowUp />
              </button>
              <button
                className="x"
                title="Move down"
                disabled={i === visible.length - 1}
                onClick={() => move(i, 1)}
              >
                <IconArrowDown />
              </button>
              <button
                className="x"
                title="Hide"
                onClick={() => onOrderChange(order.filter((x) => x !== c.id))}
              >
                <IconClose />
              </button>
            </span>
          </li>
        ))}
      </ul>

      {hidden.length > 0 && (
        <>
          <div className="col-section-label">Add</div>
          <div className="col-add-list">
            {hidden.map((c) => (
              <button
                key={c.id}
                className="btn small"
                onClick={() => !order.includes(c.id) && onOrderChange([...order, c.id])}
              >
                + {c.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="col-section-label">Custom header column</div>
      <p className="muted small">
        Pin any header as a column (e.g. <code>cf-ray</code>, <code>content-encoding</code>).
      </p>
      <div className="excluded-add">
        <input
          value={hdr}
          placeholder="cf-ray"
          onChange={(e) => setHdr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addHeaderColumn();
            }
          }}
        />
        <select value={side} onChange={(e) => setSide(e.target.value as "resp" | "req")}>
          <option value="resp">Response</option>
          <option value="req">Request</option>
        </select>
        <button className="btn" onClick={addHeaderColumn} disabled={!hdr.trim()}>
          Add
        </button>
      </div>
      {settings.headerColumns.length > 0 && (
        <ul className="excluded-list">
          {settings.headerColumns.map((spec) => (
            <li key={spec}>
              <span className="ehost">{spec}</span>
              <button
                className="x"
                title={`Remove ${spec}`}
                onClick={() => removeHeaderColumn(spec)}
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
