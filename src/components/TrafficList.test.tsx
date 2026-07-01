import type { CSSProperties } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import { CommentCell, HeaderRow } from "./TrafficList";
import { resolveColumns } from "../columns";
import type { FlowSummary } from "../types";

function flowSummary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
    seq: 1,
    method: "GET",
    host: "example.com",
    path: "/",
    scheme: "https",
    status: 200,
    mime: null,
    kind: "doc",
    reqSize: 0,
    respSize: 0,
    durationMs: null,
    ttfbMs: null,
    matchedRule: null,
    timestampMs: 0,
    comment: null,
    availability: null,
    imported: false,
    extra: {},
    ...overrides,
  };
}

function editingComments(overrides: Partial<ReturnType<typeof commentDraft>> = {}) {
  return { ...commentDraft(), ...overrides };
}

function commentDraft() {
  return {
    editingId: "1",
    draft: "",
    cancelEdit: { current: false } as { current: boolean },
    setDraft: vi.fn(),
    setEditingId: vi.fn(),
    beginEdit: vi.fn(),
    commitComment: vi.fn(),
  };
}

describe("CommentCell", () => {
  const spies: (() => void)[] = [];
  afterEach(() => {
    for (const off of spies.splice(0)) off();
  });

  function watchWindowKeydown() {
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    spies.push(() => window.removeEventListener("keydown", spy));
    return spy;
  }

  it("lets Ctrl+F bubble to the window keydown handler while editing", async () => {
    const onWindowKey = watchWindowKeydown();
    const screen = await render(<CommentCell f={flowSummary()} comments={editingComments()} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Control>}f{/Control}");

    const events = onWindowKey.mock.calls.map(([e]) => e as KeyboardEvent);
    expect(events.some((e) => e.ctrlKey && e.key.toLowerCase() === "f")).toBe(true);
  });

  it("commits the comment on Enter", async () => {
    const comments = editingComments();
    const screen = await render(<CommentCell f={flowSummary()} comments={comments} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Enter}");

    expect(comments.commitComment).toHaveBeenCalledWith("1");
    expect(comments.cancelEdit.current).toBe(true);
  });

  it("cancels the edit on Escape without committing", async () => {
    const comments = editingComments();
    const screen = await render(<CommentCell f={flowSummary()} comments={comments} />);
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("{Escape}");

    expect(comments.setEditingId).toHaveBeenCalledWith(null);
    expect(comments.commitComment).not.toHaveBeenCalled();
    expect(comments.cancelEdit.current).toBe(true);
  });
});

describe("HeaderRow sort target", () => {
  function renderHeader(onToggleSort = vi.fn()) {
    const [col] = resolveColumns(["url"], []);
    return render(
      <div className="flow-list" style={{ "--cols": "320px", "--row-w": "360px" } as CSSProperties}>
        <HeaderRow
          columns={[col]}
          headerRef={{ current: null }}
          sort={null}
          onToggleSort={onToggleSort}
          startResize={vi.fn()}
          resetWidth={vi.fn()}
        />
      </div>,
    );
  }

  it("stretches the sort button to fill the whole header cell", async () => {
    const screen = await renderHeader();
    const button = screen.getByRole("button", { name: /url/i });
    const btnEl = button.element();
    const cellEl = btnEl.parentElement as HTMLElement;

    const b = btnEl.getBoundingClientRect();
    const c = cellEl.getBoundingClientRect();

    expect(c.width).toBeGreaterThan(100);
    expect(Math.abs(b.width - c.width)).toBeLessThan(2);
    expect(Math.abs(b.height - c.height)).toBeLessThan(2);
  });

  it("sorts when clicking the empty column area, not just the label text", async () => {
    const onToggleSort = vi.fn();
    const screen = await renderHeader(onToggleSort);
    const cellEl = screen.getByRole("button", { name: /url/i }).element()
      .parentElement as HTMLElement;
    const c = cellEl.getBoundingClientRect();

    await userEvent.click(cellEl, { position: { x: c.width - 20, y: c.height / 2 } });

    expect(onToggleSort).toHaveBeenCalledWith("url");
  });
});
