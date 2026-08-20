import { useId, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { compact } from "es-toolkit";

import { COLUMN_DRAG_MIME, hasColumnDrag } from "../dnd";
import type { ProxySettings } from "../types";
import { allColumns, PRESETS } from "../columns";
import { IconArrowDown, IconArrowUp, IconClose, IconGrip } from "./icons";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

interface Props {
  order: string[];
  onOrderChange: (order: string[]) => void;
  settings: ProxySettings;
  onSettingsChange: (s: ProxySettings) => void;
}

type DropEdge = "before" | "after";

interface ColumnDropTarget {
  id: string;
  edge: DropEdge;
}

function dropEdge(e: ReactDragEvent): DropEdge {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** Reorder the resolved columns through their existing slots in the persisted
 *  order. Unknown/stale ids remain byte-for-byte at the same indexes. */
function reorderVisibleColumns(
  order: string[],
  visibleIds: string[],
  sourceId: string,
  targetId: string,
  edge: DropEdge,
): string[] | null {
  if (sourceId === targetId) return null;
  const sourceIndex = visibleIds.indexOf(sourceId);
  const targetIndex = visibleIds.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return null;

  const targetBoundary = targetIndex + (edge === "after" ? 1 : 0);
  const insertionIndex = targetBoundary - (sourceIndex < targetBoundary ? 1 : 0);
  if (insertionIndex === sourceIndex) return null;

  const reordered = [...visibleIds];
  reordered.splice(sourceIndex, 1);
  reordered.splice(insertionIndex, 0, sourceId);

  const visibleSet = new Set(visibleIds);
  let visibleIndex = 0;
  return order.map((id) => (visibleSet.has(id) ? reordered[visibleIndex++] : id));
}

export function ColumnsSettings({ order, onOrderChange, settings, onSettingsChange }: Props) {
  const [hdr, setHdr] = useState("");
  const [side, setSide] = useState<"resp" | "req">("resp");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ColumnDropTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragDepth = useRef(0);
  const dropTargetRef = useRef<ColumnDropTarget | null>(null);
  const instructionsId = useId();

  const all = allColumns(settings.headerColumns);
  const byId = new Map(all.map((c) => [c.id, c]));
  const visible = compact(order.map((id) => byId.get(id)));
  const hidden = all.filter((c) => !order.includes(c.id));
  const visibleIds = visible.map((c) => c.id);

  function announceMove(id: string, next: string[]) {
    const position = compact(next.map((columnId) => byId.get(columnId))).findIndex(
      (column) => column.id === id,
    );
    const column = byId.get(id);
    if (column && position >= 0) {
      setAnnouncement(`${column.label} moved to position ${position + 1} of ${visible.length}.`);
    }
  }

  function commitMove(id: string, next: string[]) {
    onOrderChange(next);
    announceMove(id, next);
  }

  function clearDrag() {
    dragDepth.current = 0;
    dropTargetRef.current = null;
    setDragId(null);
    setDropTarget(null);
  }

  function updateDropTarget(next: ColumnDropTarget | null) {
    dropTargetRef.current = next;
    setDropTarget(next);
  }

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
    commitMove(visible[i].id, next);
  }
  function dragStart(e: ReactDragEvent, id: string) {
    dragDepth.current = 0;
    updateDropTarget(null);
    setDragId(id);
    e.dataTransfer.setData(COLUMN_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  }
  function dragOver(e: ReactDragEvent, targetId: string) {
    if (!hasColumnDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const edge = dropEdge(e);
    const sourceId = dragId || e.dataTransfer.getData(COLUMN_DRAG_MIME);
    const next = sourceId
      ? reorderVisibleColumns(order, visibleIds, sourceId, targetId, edge)
      : null;
    updateDropTarget(next ? { id: targetId, edge } : null);
  }
  function listDrop(e: ReactDragEvent) {
    if (!hasColumnDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    const sourceId = e.dataTransfer.getData(COLUMN_DRAG_MIME) || dragId;
    const target = dropTargetRef.current;
    const next =
      sourceId && target
        ? reorderVisibleColumns(order, visibleIds, sourceId, target.id, target.edge)
        : null;
    clearDrag();
    if (sourceId && next) commitMove(sourceId, next);
  }
  function listDragEnter(e: ReactDragEvent) {
    if (hasColumnDrag(e.dataTransfer.types)) dragDepth.current += 1;
  }
  function listDragLeave(e: ReactDragEvent) {
    if (!hasColumnDrag(e.dataTransfer.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) updateDropTarget(null);
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
      <p className="muted small" id={instructionsId}>
        Choose which columns the traffic list shows and their order. Drag a shown column by its
        handle, or use its arrow buttons. Resize columns by dragging the traffic-list header
        dividers.
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
      <ul
        className="col-list"
        aria-label="Shown columns"
        aria-describedby={instructionsId}
        onDragEnter={listDragEnter}
        onDragLeave={listDragLeave}
        onDragOver={(e) => {
          if (!hasColumnDrag(e.dataTransfer.types)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={listDrop}
      >
        {visible.map((c, i) => (
          <li
            key={c.id}
            className={[
              dragId === c.id && "dragging",
              dropTarget?.id === c.id && `drop-${dropTarget.edge}`,
            ]
              .filter(Boolean)
              .join(" ")}
            aria-posinset={i + 1}
            aria-setsize={visible.length}
            onDragOver={(e) => dragOver(e, c.id)}
          >
            <span
              className="col-drag-handle"
              title={`Drag ${c.label} to reorder`}
              aria-hidden="true"
              draggable
              onDragStart={(e) => dragStart(e, c.id)}
              onDragEnd={clearDrag}
            >
              <IconGrip />
            </span>
            <span className="col-name">{c.label}</span>
            <span className="col-actions">
              <IconButton
                label={`Move ${c.label} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <IconArrowUp />
              </IconButton>
              <IconButton
                label={`Move ${c.label} down`}
                disabled={i === visible.length - 1}
                onClick={() => move(i, 1)}
              >
                <IconArrowDown />
              </IconButton>
              <IconButton
                label={`Hide ${c.label}`}
                onClick={() => onOrderChange(order.filter((x) => x !== c.id))}
              >
                <IconClose />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
      <span className="col-reorder-status" role="status">
        {announcement}
      </span>

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
