import { useState } from "react";
import { compact } from "es-toolkit";

import type { ProxySettings } from "../types";
import { allColumns, PRESETS } from "../columns";
import { IconArrowDown, IconArrowUp, IconClose } from "./icons";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

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
          <Button key={p.name} size="small" onClick={() => onOrderChange(p.columns)}>
            {p.name}
          </Button>
        ))}
      </div>

      <div className="col-section-label">Shown</div>
      <ul className="col-list">
        {visible.map((c, i) => (
          <li key={c.id}>
            <span className="col-name">{c.label}</span>
            <span className="col-actions">
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <IconArrowUp />
              </IconButton>
              <IconButton
                label="Move down"
                disabled={i === visible.length - 1}
                onClick={() => move(i, 1)}
              >
                <IconArrowDown />
              </IconButton>
              <IconButton
                label="Hide"
                onClick={() => onOrderChange(order.filter((x) => x !== c.id))}
              >
                <IconClose />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>

      {hidden.length > 0 && (
        <>
          <div className="col-section-label">Add</div>
          <div className="col-add-list">
            {hidden.map((c) => (
              <Button
                key={c.id}
                size="small"
                onClick={() => !order.includes(c.id) && onOrderChange([...order, c.id])}
              >
                + {c.label}
              </Button>
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
        <Button onClick={addHeaderColumn} disabled={!hdr.trim()}>
          Add
        </Button>
      </div>
      {settings.headerColumns.length > 0 && (
        <ul className="excluded-list">
          {settings.headerColumns.map((spec) => (
            <li key={spec}>
              <span className="ehost">{spec}</span>
              <IconButton danger label={`Remove ${spec}`} onClick={() => removeHeaderColumn(spec)}>
                <IconClose />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
