import { useMemo, useState } from "react";

import {
  changedSpanMap,
  diffLines,
  diffStats,
  foldContext,
  foldSplit,
  splitRows,
  type CharSpan,
  type DiffLine,
  type SplitPair,
} from "../diff";
import type { MessageDetail } from "../types";
import { Button } from "./ui/Button";

// Pure renderers for the compare view's diff screen (issue #86). No IPC — the
// data-fetching container lives in CompareDiff.tsx, so these stay browser-
// testable (see DiffView.test.tsx).

/** How a diff is laid out: side-by-side cells or a unified +/- column. */
export type DiffMode = "split" | "unified";

/** Diffs longer than this render a tail note instead of more rows. */
const MAX_RENDERED_ROWS = 1500;
/** Pathologically long lines (minified payloads) are sliced for display. */
const MAX_LINE_CHARS = 2000;

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  return `${text.slice(0, MAX_LINE_CHARS)} … (+${text.length - MAX_LINE_CHARS} chars)`;
}

const SIGNS = { same: " ", del: "-", add: "+" } as const;

/** Line text with the changed middle marked (issue #86 feedback: near-identical
 *  long lines must show the exact change, not just a colored row). */
function MarkedText({ text, span }: { text: string; span?: CharSpan }) {
  const clipped = clipLine(text);
  if (!span || span.start >= clipped.length || span.end <= span.start) return <>{clipped}</>;
  const end = Math.min(span.end, clipped.length);
  return (
    <>
      {clipped.slice(0, span.start)}
      <span className="diff-chg">{clipped.slice(span.start, end)}</span>
      {clipped.slice(end)}
    </>
  );
}

function DiffLineRow({ line, span }: { line: DiffLine; span?: CharSpan }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-ln">{line.left ?? ""}</span>
      <span className="diff-ln">{line.right ?? ""}</span>
      <span className="diff-sign">{SIGNS[line.kind]}</span>
      <span className="diff-text">
        <MarkedText text={line.text} span={span} />
      </span>
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

function FoldButton({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      className="diff-fold"
      onClick={onExpand}
      title="Show these unchanged lines"
    >
      ··· {count} unchanged lines ···
    </button>
  );
}

function TailNote({ hidden }: { hidden: number }) {
  if (hidden <= 0) return null;
  return <div className="diff-tail muted">… {hidden} more rows not shown</div>;
}

function UnifiedDiffRows({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const rows = useMemo(() => renderRows(lines, expanded), [lines, expanded]);
  const spans = useMemo(() => changedSpanMap(lines), [lines]);
  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  const expand = (index: number) => setExpanded((prev) => new Set(prev).add(index));
  return (
    <div className="diff-rows">
      {shown.map((row) =>
        row.kind === "line" ? (
          <DiffLineRow key={row.key} line={row.line} span={spans.get(row.line)} />
        ) : (
          <FoldButton key={row.key} count={row.count} onExpand={() => expand(row.index)} />
        ),
      )}
      <TailNote hidden={rows.length - shown.length} />
    </div>
  );
}

function SplitCell({
  line,
  side,
  span,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  span?: CharSpan;
}) {
  if (line === null) return <div className="diff-cell void" />;
  return (
    <div className={`diff-cell ${line.kind}`}>
      <span className="diff-ln">{(side === "left" ? line.left : line.right) ?? ""}</span>
      <span className="diff-sign">{SIGNS[line.kind]}</span>
      <span className="diff-text">
        <MarkedText text={line.text} span={span} />
      </span>
    </div>
  );
}

type SplitRenderRow =
  | { key: string; kind: "pair"; pair: SplitPair }
  | { key: string; kind: "fold"; index: number; count: number };

function renderSplit(pairs: SplitPair[], expanded: Set<number>): SplitRenderRow[] {
  const rows: SplitRenderRow[] = [];
  for (const [index, row] of foldSplit(pairs).entries()) {
    if (row.kind === "pair") {
      rows.push({ key: `p${index}`, kind: "pair", pair: row });
    } else if (expanded.has(index)) {
      rows.push(
        ...row.pairs.map(
          (pair, i): SplitRenderRow => ({ key: `p${index}.${i}`, kind: "pair", pair }),
        ),
      );
    } else {
      rows.push({ key: `f${index}`, kind: "fold", index, count: row.count });
    }
  }
  return rows;
}

function SplitDiffRows({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const pairs = useMemo(() => splitRows(lines), [lines]);
  const spans = useMemo(() => changedSpanMap(lines), [lines]);
  const rows = useMemo(() => renderSplit(pairs, expanded), [pairs, expanded]);
  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  const expand = (index: number) => setExpanded((prev) => new Set(prev).add(index));
  return (
    <div className="diff-rows">
      {shown.map((row) =>
        row.kind === "pair" ? (
          <div key={row.key} className="diff-srow">
            <SplitCell
              line={row.pair.left}
              side="left"
              span={row.pair.left ? spans.get(row.pair.left) : undefined}
            />
            <SplitCell
              line={row.pair.right}
              side="right"
              span={row.pair.right ? spans.get(row.pair.right) : undefined}
            />
          </div>
        ) : (
          <FoldButton key={row.key} count={row.count} onExpand={() => expand(row.index)} />
        ),
      )}
      <TailNote hidden={rows.length - shown.length} />
    </div>
  );
}

/** Diff rows with git-like folded context; folds expand on click. Side-by-side
 *  by default (the compare window's preference), unified on request. */
export function DiffRows({ lines, mode = "unified" }: { lines: DiffLine[]; mode?: DiffMode }) {
  return mode === "split" ? <SplitDiffRows lines={lines} /> : <UnifiedDiffRows lines={lines} />;
}

/** One diffed text block (request head or response head) with a change badge. */
export function DiffBlock({
  title,
  a,
  b,
  mode,
}: {
  title: string;
  a: string;
  b: string;
  mode?: DiffMode;
}) {
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
      <DiffRows lines={lines} mode={mode} />
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

function BodyHunks({
  a,
  b,
  mode,
}: {
  a: MessageDetail | null;
  b: MessageDetail | null;
  mode?: DiffMode;
}) {
  const truncated = !!(a?.truncated || b?.truncated);
  return (
    <div className="diff-body-hunks">
      {truncated && (
        <div className="diff-tail muted">
          diff of the first 512 KB per side — fetch is capped for display
        </div>
      )}
      <DiffRows lines={diffLines(a?.bodyText ?? "", b?.bodyText ?? "")} mode={mode} />
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
  mode?: DiffMode;
}

/**
 * A body is diffed by default but NOT shown (issue #86): this row reports the
 * verdict and sizes, and only an explicit toggle renders the hunks. Binary
 * bodies never render as a text diff.
 */
export function BodyDiffSection({
  label,
  a,
  b,
  equal,
  shown,
  onToggle,
  mode,
}: BodyDiffSectionProps) {
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
        <Button variant="ghost" size="small" onClick={onToggle}>
          {shown ? "Hide body diff" : "Show body diff"}
        </Button>
      )}
      {shown && !binary && <BodyHunks a={a} b={b} mode={mode} />}
    </div>
  );
}
