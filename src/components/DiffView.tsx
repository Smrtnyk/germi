import { useMemo, useState } from "react";

import { diffLines, diffStats, foldContext, type DiffLine } from "../diff";
import type { MessageDetail } from "../types";

// Pure renderers for the compare view's diff screen (issue #86). No IPC — the
// data-fetching container lives in CompareDiff.tsx, so these stay browser-
// testable (see DiffView.test.tsx).

/** Diffs longer than this render a tail note instead of more rows. */
const MAX_RENDERED_ROWS = 1500;
/** Pathologically long lines (minified payloads) are sliced for display. */
const MAX_LINE_CHARS = 2000;

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  return `${text.slice(0, MAX_LINE_CHARS)} … (+${text.length - MAX_LINE_CHARS} chars)`;
}

const SIGNS = { same: " ", del: "-", add: "+" } as const;

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-ln">{line.left ?? ""}</span>
      <span className="diff-ln">{line.right ?? ""}</span>
      <span className="diff-sign">{SIGNS[line.kind]}</span>
      <span className="diff-text">{clipLine(line.text)}</span>
    </div>
  );
}

type RenderRow =
  | { key: string; kind: "line"; line: DiffLine }
  | { key: string; kind: "fold"; index: number; count: number };

function renderRows(lines: DiffLine[], expanded: Set<number>): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const [index, row] of foldContext(lines).entries()) {
    if (row.kind !== "fold") {
      rows.push({ key: `l${index}`, kind: "line", line: row });
    } else if (expanded.has(index)) {
      rows.push(
        ...row.lines.map((line, i): RenderRow => ({ key: `l${index}.${i}`, kind: "line", line })),
      );
    } else {
      rows.push({ key: `f${index}`, kind: "fold", index, count: row.count });
    }
  }
  return rows;
}

/** Unified diff rows with git-like folded context; folds expand on click. */
export function DiffRows({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const rows = useMemo(() => renderRows(lines, expanded), [lines, expanded]);
  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  const expand = (index: number) => setExpanded((prev) => new Set(prev).add(index));
  return (
    <div className="diff-rows">
      {shown.map((row) =>
        row.kind === "line" ? (
          <DiffLineRow key={row.key} line={row.line} />
        ) : (
          <button
            key={row.key}
            type="button"
            className="diff-fold"
            onClick={() => expand(row.index)}
            title="Show these unchanged lines"
          >
            ··· {row.count} unchanged lines ···
          </button>
        ),
      )}
      {rows.length > shown.length && (
        <div className="diff-tail muted">… {rows.length - shown.length} more rows not shown</div>
      )}
    </div>
  );
}

/** One diffed text block (request head or response head) with a change badge. */
export function DiffBlock({ title, a, b }: { title: string; a: string; b: string }) {
  const lines = useMemo(() => diffLines(a, b), [a, b]);
  const stats = diffStats(lines);
  const changed = stats.added + stats.removed > 0;
  return (
    <section className="diff-section">
      <div className="diff-section-head">
        <span className="diff-section-title">{title}</span>
        {changed ? (
          <span className="diff-stats">
            <span className="diff-added">+{stats.added}</span>
            <span className="diff-removed">−{stats.removed}</span>
          </span>
        ) : (
          <span className="diff-stats muted">identical</span>
        )}
      </div>
      <DiffRows lines={lines} />
    </section>
  );
}

function sizeLabel(n: number): string {
  if (n === 0) return "empty";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function bodyVerdict(equal: boolean | null, aSize: number, bSize: number): string {
  if (equal === true) return `identical · ${sizeLabel(aSize)}`;
  if (equal === false) return `differ · ${sizeLabel(aSize)} vs ${sizeLabel(bSize)}`;
  return `${sizeLabel(aSize)} vs ${sizeLabel(bSize)}`;
}

function BodyHunks({ a, b }: { a: MessageDetail | null; b: MessageDetail | null }) {
  const truncated = !!(a?.truncated || b?.truncated);
  return (
    <div className="diff-body-hunks">
      {truncated && (
        <div className="diff-tail muted">
          diff of the first 512 KB per side — fetch is capped for display
        </div>
      )}
      <DiffRows lines={diffLines(a?.bodyText ?? "", b?.bodyText ?? "")} />
    </div>
  );
}

export interface BodyDiffSectionProps {
  label: string;
  a: MessageDetail | null;
  b: MessageDetail | null;
  /** Backend byte-equality of the decoded bodies; null when not comparable. */
  equal: boolean | null;
  shown: boolean;
  onToggle: () => void;
}

/**
 * A body is diffed by default but NOT shown (issue #86): this row reports the
 * verdict and sizes, and only an explicit toggle renders the hunks. Binary
 * bodies never render as a text diff.
 */
export function BodyDiffSection({ label, a, b, equal, shown, onToggle }: BodyDiffSectionProps) {
  const aSize = a?.size ?? 0;
  const bSize = b?.size ?? 0;
  if (aSize === 0 && bSize === 0) {
    return (
      <div className="diff-body">
        <span className="diff-body-label">{label}</span>
        <span className="muted">none on either side</span>
      </div>
    );
  }
  const binary = !!(a?.bodyBase64 || b?.bodyBase64);
  return (
    <div className="diff-body">
      <span className="diff-body-label">{label}</span>
      <span className={equal === false ? "diff-verdict changed" : "diff-verdict"}>
        {bodyVerdict(equal, aSize, bSize)}
        {binary && " · binary"}
      </span>
      {!binary && (
        <button type="button" className="btn ghost small" onClick={onToggle}>
          {shown ? "Hide body diff" : "Show body diff"}
        </button>
      )}
      {shown && !binary && <BodyHunks a={a} b={b} />}
    </div>
  );
}
