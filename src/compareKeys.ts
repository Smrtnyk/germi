import { isTypingTarget } from "./hotkey";

// Window-level keyboard model for the compare window (issue #86 / #104), kept
// pure and IPC-free so it node-tests like `shortcuts.ts`. `useCompareKeys` in
// CompareView.tsx wires these intents to the panes; the mapping lives here.

export interface CompareKeyActions {
  diffOpen: boolean;
  canDiff: boolean;
  openDiff: () => void;
  closeDiff: () => void;
  close: () => void;
  moveSelectedRight: () => void;
  moveSelectedLeft: () => void;
  stepActive: (dir: 1 | -1, extend: boolean) => void;
  selectAllActive: () => void;
}

/** Esc steps back from the diff, then closes the window — the issue's explicit
 *  ask. Ctrl/⌘+A marks every visible row of the active pane instead of letting
 *  the browser select the page text (issue #104). Typing in a pane filter is
 *  left alone entirely (the input handles its own Esc-to-clear and Ctrl+A). */
export function handleCompareKeys(e: KeyboardEvent, ctx: CompareKeyActions): void {
  if (isTypingTarget(e.target)) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (ctx.diffOpen) ctx.closeDiff();
    else ctx.close();
    return;
  }
  if (ctx.diffOpen) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    ctx.selectAllActive();
    return;
  }
  if (e.key === "Enter") {
    if (ctx.canDiff && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      ctx.openDiff();
    }
    return;
  }
  const nav: Record<string, () => void> = {
    ArrowUp: () => ctx.stepActive(-1, e.shiftKey),
    ArrowDown: () => ctx.stepActive(1, e.shiftKey),
    ArrowRight: ctx.moveSelectedRight,
    ArrowLeft: ctx.moveSelectedLeft,
  };
  const run = nav[e.key];
  if (run) {
    e.preventDefault();
    run();
  }
}
