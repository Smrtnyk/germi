import { describe, expect, it } from "vitest";
import {
  changedSpanMap,
  changedSpans,
  diffLines,
  diffStats,
  foldContext,
  foldSplit,
  lcsLength,
  splitRows,
  type DiffLine,
} from "./diff";

function shape(lines: DiffLine[]): string[] {
  return lines.map((l) => `${l.kind === "same" ? " " : l.kind === "del" ? "-" : "+"}${l.text}`);
}

describe("diffLines", () => {
  it("marks identical inputs as all-same with paired line numbers", () => {
    const lines = diffLines("a\nb", "a\nb");
    expect(shape(lines)).toEqual([" a", " b"]);
    expect(lines[1]).toMatchObject({ left: 2, right: 2 });
  });

  it("diffs empty against empty to nothing", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("treats a fully-added and fully-removed text as adds/dels", () => {
    expect(shape(diffLines("", "x\ny"))).toEqual(["+x", "+y"]);
    expect(shape(diffLines("x\ny", ""))).toEqual(["-x", "-y"]);
  });

  it("puts the deletion before the addition in a changed block", () => {
    expect(shape(diffLines("keep\nold\ntail", "keep\nnew\ntail"))).toEqual([
      " keep",
      "-old",
      "+new",
      " tail",
    ]);
  });

  it("aligns around an inserted line instead of cascading changes", () => {
    expect(shape(diffLines("Host: a\nAccept: */*", "Host: a\nX-New: 1\nAccept: */*"))).toEqual([
      " Host: a",
      "+X-New: 1",
      " Accept: */*",
    ]);
  });

  it("numbers each side independently", () => {
    const lines = diffLines("a\nb", "a\nc\nb");
    expect(lines.find((l) => l.kind === "add")).toMatchObject({ left: null, right: 2 });
    expect(lines[lines.length - 1]).toMatchObject({ left: 2, right: 3 });
  });

  it("survives inputs too large for LCS alignment via the plain fallback", () => {
    const a = Array.from({ length: 2100 }, (_, i) => `left ${i}`).join("\n");
    const b = Array.from({ length: 2100 }, (_, i) => `right ${i}`).join("\n");
    const stats = diffStats(diffLines(a, b));
    expect(stats).toEqual({ added: 2100, removed: 2100 });
  });
});

describe("diffStats", () => {
  it("counts added and removed lines", () => {
    expect(diffStats(diffLines("a\nb\nc", "a\nx\ny\nc"))).toEqual({ added: 2, removed: 1 });
  });
});

describe("foldContext", () => {
  const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  it("collapses a long unchanged run into a fold, keeping context around changes", () => {
    const left = `changed\n${body(20)}`;
    const right = `CHANGED\n${body(20)}`;
    const rows = foldContext(diffLines(left, right), 3);
    expect(rows.slice(0, 2).map((r) => r.kind)).toEqual(["del", "add"]);
    const fold = rows[rows.length - 1];
    expect(fold).toMatchObject({ kind: "fold", count: 17 });
    expect(rows).toHaveLength(2 + 3 + 1);
  });

  it("keeps short unchanged runs inline instead of folding them", () => {
    const rows = foldContext(diffLines(`x\n${body(4)}\ny`, `X\n${body(4)}\nY`), 1);
    expect(rows.every((r) => r.kind !== "fold")).toBe(true);
  });

  it("folds an entirely-unchanged diff into a single fold row", () => {
    const rows = foldContext(diffLines(body(30), body(30)), 3);
    expect(rows).toEqual([expect.objectContaining({ kind: "fold", count: 30 })]);
  });
});

describe("splitRows", () => {
  it("pairs an unchanged line with itself", () => {
    const pairs = splitRows(diffLines("a", "a"));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].left?.text).toBe("a");
    expect(pairs[0].right?.text).toBe("a");
  });

  it("aligns a deletion run with the addition run that follows it", () => {
    const pairs = splitRows(diffLines("keep\nold\ntail", "keep\nnew\ntail"));
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["keep", "keep"],
      ["old", "new"],
      ["tail", "tail"],
    ]);
  });

  it("pads the shorter side of an unbalanced change with empty cells", () => {
    const pairs = splitRows(diffLines("x", "x\nadded1\nadded2"));
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["x", "x"],
      [null, "added1"],
      [null, "added2"],
    ]);
  });

  it("carries per-side line numbers into the cells", () => {
    const pairs = splitRows(diffLines("a\nb", "a\nc"));
    const changed = pairs[1];
    expect(changed.left).toMatchObject({ left: 2, right: null });
    expect(changed.right).toMatchObject({ left: null, right: 2 });
  });
});

describe("foldSplit", () => {
  it("folds long unchanged runs of pairs, keeping context around changes", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const rows = foldSplit(splitRows(diffLines(`changed\n${body}`, `CHANGED\n${body}`)), 3);
    expect(rows[0]).toMatchObject({ kind: "pair" });
    expect(rows[rows.length - 1]).toMatchObject({ kind: "fold", count: 17 });
  });
});

describe("changedSpans", () => {
  it("isolates the changed middle of two near-identical lines", () => {
    const spans = changedSpans("X-Feature-Flags: checkout-v2", "X-Feature-Flags: checkout-v3");
    expect(spans?.left).toEqual({ start: 27, end: 28 });
    expect(spans?.right).toEqual({ start: 27, end: 28 });
  });

  it("marks an insertion as an empty span on the shorter side", () => {
    const spans = changedSpans("a=1&b=2", "a=1&x=9&b=2");
    expect(spans?.left.start).toBe(spans?.left.end);
    const right = spans?.right;
    expect("a=1&x=9&b=2".slice(right?.start, right?.end)).toBe("x=9&");
  });

  it("returns null for equal lines and for lines that differ almost everywhere", () => {
    expect(changedSpans("same", "same")).toBeNull();
    expect(changedSpans("completely different content", "nothing shared here at all!")).toBeNull();
  });

  it("keys marks to both sides of every del/add pair in a diff", () => {
    const lines = diffLines("keep\nvalue: old\ntail", "keep\nvalue: new\ntail");
    const spans = changedSpanMap(lines);
    const del = lines.find((l) => l.kind === "del");
    const add = lines.find((l) => l.kind === "add");
    expect(del && spans.get(del)).toEqual({ start: 7, end: 10 });
    expect(add && spans.get(add)).toEqual({ start: 7, end: 10 });
  });

  it("leaves pure insertions and deletions unmarked", () => {
    const lines = diffLines("a", "a\nadded");
    expect(changedSpanMap(lines).size).toBe(0);
  });
});

describe("lcsLength", () => {
  it("measures the longest common subsequence of token lists", () => {
    expect(lcsLength(["api", "users"], ["api", "v2", "users"])).toBe(2);
    expect(lcsLength([], ["a"])).toBe(0);
    expect(lcsLength(["a", "b"], ["a", "b"])).toBe(2);
  });
});
