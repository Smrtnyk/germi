import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CommentCell } from "./TrafficList";
import type { FlowSummary } from "../types";

function flowSummary(overrides: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "1",
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
