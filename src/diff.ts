// Line-level diff for the compare view (issue #86): git-like unified output
// with per-side line numbers and folded unchanged context. Pure logic — the
// rendering lives in CompareDiff.tsx.

export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
  /** 1-based line number on the left side; null for an added line. */
  left: number | null;
  /** 1-based line number on the right side; null for a deleted line. */
  right: number | null;
}

/** A collapsed run of unchanged lines, expandable in the UI. */
export interface DiffFold {
  kind: "fold";
  count: number;
  lines: DiffLine[];
}

export type DiffRow = DiffLine | DiffFold;

interface DiffOp {
  kind: DiffLine["kind"];
  text: string;
}

/** LCS matrixes beyond this many cells fall back to a plain del-all/add-all
 *  diff — inputs that different aren't human-readable as a line diff anyway. */
const MAX_LCS_CELLS = 4_000_000;

/** Unchanged runs longer than this collapse into a fold row. */
const MIN_FOLD_RUN = 5;

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

function lcsTable(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * width + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * width + (j - 1)] + 1
          : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)]);
    }
  }
  return dp;
}

/** Length of the longest common subsequence of two token lists. */
export function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dp = lcsTable(a, b);
  return dp[a.length * (b.length + 1) + b.length];
}

function backtrack(dp: Uint32Array, a: string[], b: string[]): DiffOp[] {
  const width = b.length + 1;
  const out: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i * width + (j - 1)] >= dp[(i - 1) * width + j]) {
      out.push({ kind: "add", text: b[j - 1] });
      j--;
    } else {
      out.push({ kind: "del", text: a[i - 1] });
      i--;
    }
  }
  while (i > 0) out.push({ kind: "del", text: a[--i] });
  while (j > 0) out.push({ kind: "add", text: b[--j] });
  return out.reverse();
}

function middleOps(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0) return b.map((text) => ({ kind: "add", text }));
  if (b.length === 0) return a.map((text) => ({ kind: "del", text }));
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffOp => ({ kind: "del", text })),
      ...b.map((text): DiffOp => ({ kind: "add", text })),
    ];
  }
  return backtrack(lcsTable(a, b), a, b);
}

function withNumbers(ops: DiffOp[]): DiffLine[] {
  let left = 0;
  let right = 0;
  return ops.map((op) => ({
    ...op,
    left: op.kind === "add" ? null : ++left,
    right: op.kind === "del" ? null : ++right,
  }));
}

/**
 * Diff two texts line by line. Common prefix/suffix lines are trimmed first
 * (the dominant case for HTTP messages), the changed middle goes through an
 * LCS alignment, and deletions precede additions within a changed block.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const al = splitLines(a);
  const bl = splitLines(b);
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
  let endA = al.length;
  let endB = bl.length;
  while (endA > start && endB > start && al[endA - 1] === bl[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text: string): DiffOp => ({ kind: "same", text });
  return withNumbers([
    ...al.slice(0, start).map(same),
    ...middleOps(al.slice(start, endA), bl.slice(start, endB)),
    ...al.slice(endA).map(same),
  ]);
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Collapse long unchanged runs into fold rows, keeping `context` unchanged
 * lines around every change (the git hunk look). Runs of at most
 * `MIN_FOLD_RUN` hidden lines stay inline — a one-line fold is worse than the
 * line itself.
 */
export function foldContext(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "same") continue;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  }
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      rows.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    const hidden = lines.slice(i, j);
    if (hidden.length <= MIN_FOLD_RUN) rows.push(...hidden);
    else rows.push({ kind: "fold", count: hidden.length, lines: hidden });
    i = j;
  }
  return rows;
}
