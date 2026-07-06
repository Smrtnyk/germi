import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../styles.css";
import {
  RuleBulkSelection,
  useRuleSelection,
  VirtualRuleList,
  type RuleListBehavior,
} from "./AutoresponderPanel";
import type { RuleSummary } from "../types";

function rule(id: string): RuleSummary {
  return {
    id,
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "GET", url: `https://example.com/${id}`, urlMatch: "exact" },
    action: {
      kind: "respond",
      status: 200,
      contentType: "application/json",
      contentEncoding: null,
    },
  };
}

type Mods = { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean };

/** Drives the real selection hook through plain clicks that carry explicit
 *  modifier flags, so the branch logic (plain / ctrl-toggle / shift-range) and
 *  the resulting state are exercised without depending on modifier-click
 *  fidelity or the virtualizer. Selection follows the rule list via dropMissing. */
function Harness({ initial }: { initial: RuleSummary[] }) {
  const [rules, setRules] = useState(initial);
  const selection = useRuleSelection();
  const ids = rules.map((r) => r.id);
  useEffect(() => {
    selection.retainVisible(rules.map((r) => r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);
  const click = (id: string, mods: Mods = {}) =>
    selection.onRowClick(ids, id, {
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    } as unknown as ReactMouseEvent);
  return (
    <div>
      {rules.map((r) => (
        <div key={r.id}>
          <button data-testid={`row-${r.id}`} onClick={() => click(r.id)}>
            {r.id}
          </button>
          <button data-testid={`ctrl-${r.id}`} onClick={() => click(r.id, { ctrlKey: true })}>
            ctrl-{r.id}
          </button>
          <button data-testid={`shift-${r.id}`} onClick={() => click(r.id, { shiftKey: true })}>
            shift-{r.id}
          </button>
        </div>
      ))}
      <button data-testid="select-all" onClick={() => selection.selectAll(ids)}>
        all
      </button>
      <button data-testid="clear" onClick={() => selection.clearSelection()}>
        clear
      </button>
      <button
        data-testid="remove-r2"
        onClick={() => setRules((rs) => rs.filter((r) => r.id !== "r2"))}
      >
        rm
      </button>
      <button
        data-testid="remove-active"
        onClick={() => setRules((rs) => rs.filter((r) => r.id !== selection.selectedRuleId))}
      >
        rm-active
      </button>
      <span data-testid="ids">[{[...selection.selectedIds].join(",")}]</span>
      <span data-testid="active">[{selection.selectedRuleId ?? ""}]</span>
    </div>
  );
}

describe("useRuleSelection multi-select", () => {
  const ids = (screen: Awaited<ReturnType<typeof render>>) => screen.getByTestId("ids");
  const active = (screen: Awaited<ReturnType<typeof render>>) => screen.getByTestId("active");

  it("plain click selects exactly one rule as the active row", async () => {
    const screen = await render(<Harness initial={[rule("r1"), rule("r2"), rule("r3")]} />);
    await screen.getByTestId("row-r2").click();
    await expect.element(ids(screen)).toHaveTextContent("[r2]");
    await expect.element(active(screen)).toHaveTextContent("[r2]");
  });

  it("ctrl-click adds to and toggles rules out of the selection", async () => {
    const screen = await render(<Harness initial={[rule("r1"), rule("r2"), rule("r3")]} />);
    await screen.getByTestId("row-r1").click();
    await screen.getByTestId("ctrl-r3").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1,r3]");
    await expect.element(active(screen)).toHaveTextContent("[r3]");
    // Ctrl-clicking the active row again removes it and re-homes the active row.
    await screen.getByTestId("ctrl-r3").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1]");
    await expect.element(active(screen)).toHaveTextContent("[r1]");
  });

  it("shift-click selects the inclusive range from the anchor", async () => {
    const screen = await render(
      <Harness initial={[rule("r1"), rule("r2"), rule("r3"), rule("r4")]} />,
    );
    await screen.getByTestId("row-r2").click();
    await screen.getByTestId("shift-r4").click();
    await expect.element(ids(screen)).toHaveTextContent("[r2,r3,r4]");
    await expect.element(active(screen)).toHaveTextContent("[r4]");
  });

  it("select-all picks every rule; clear empties the selection", async () => {
    const screen = await render(<Harness initial={[rule("r1"), rule("r2"), rule("r3")]} />);
    await screen.getByTestId("select-all").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1,r2,r3]");
    await screen.getByTestId("clear").click();
    await expect.element(ids(screen)).toHaveTextContent("[]");
    await expect.element(active(screen)).toHaveTextContent("[]");
  });

  it("drops a removed rule from the selection so bulk delete can't target a phantom", async () => {
    const screen = await render(<Harness initial={[rule("r1"), rule("r2"), rule("r3")]} />);
    await screen.getByTestId("select-all").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1,r2,r3]");
    await screen.getByTestId("remove-r2").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1,r3]");
  });

  it("re-homes the active row onto a survivor when the active rule is removed", async () => {
    const screen = await render(<Harness initial={[rule("r1"), rule("r2"), rule("r3")]} />);
    // select-all makes the last row (r3) the active/primary row.
    await screen.getByTestId("select-all").click();
    await expect.element(active(screen)).toHaveTextContent("[r3]");
    await screen.getByTestId("remove-active").click();
    await expect.element(ids(screen)).toHaveTextContent("[r1,r2]");
    // The invariant holds: the active id is still a member of the selection.
    await expect.element(active(screen)).toHaveTextContent("[r2]");
  });
});

/** A static behavior wired to spies — isolates the viewport keyboard handling
 *  (issue #106) from selection state. */
function keyBehavior(over: Partial<RuleListBehavior> = {}): RuleListBehavior {
  return {
    selectedRuleId: null,
    selectedIds: new Set(),
    onRowClick: vi.fn(),
    ensureSelected: vi.fn(),
    onSelectAll: vi.fn(),
    onDeleteSelected: vi.fn(),
    onClearSelection: vi.fn(),
    openWindowRuleIds: new Set(),
    onOpen: vi.fn(),
    canReorder: false,
    dragId: null,
    setDragId: vi.fn(),
    overId: null,
    setOverId: vi.fn(),
    ruleHits: {},
    onToggle: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onMoveToTop: vi.fn(),
    onMoveToBottom: vi.fn(),
    onReorder: vi.fn(),
    ...over,
  };
}

describe("rule list keyboard shortcuts", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const off of cleanups.splice(0)) off();
  });

  function watchWindowKeydown() {
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    cleanups.push(() => window.removeEventListener("keydown", spy));
    return spy;
  }

  it("Ctrl+A selects all and is shielded from the window handler", async () => {
    const onSelectAll = vi.fn();
    const onWindowKey = watchWindowKeydown();
    const screen = await render(
      <VirtualRuleList rules={[rule("r1")]} behavior={keyBehavior({ onSelectAll })} />,
    );
    (screen.getByRole("listbox").element() as HTMLElement).focus();
    await userEvent.keyboard("{Control>}a{/Control}");

    expect(onSelectAll).toHaveBeenCalledOnce();
    const sawCtrlA = onWindowKey.mock.calls.some(
      ([e]) => (e as KeyboardEvent).ctrlKey && (e as KeyboardEvent).key.toLowerCase() === "a",
    );
    expect(sawCtrlA, "Ctrl+A must not bubble to the window select-all handler").toBe(false);
  });

  it("Delete deletes the selection when it is non-empty", async () => {
    const onDeleteSelected = vi.fn();
    const screen = await render(
      <VirtualRuleList
        rules={[rule("r1")]}
        behavior={keyBehavior({ selectedIds: new Set(["r1"]), onDeleteSelected })}
      />,
    );
    (screen.getByRole("listbox").element() as HTMLElement).focus();
    await userEvent.keyboard("{Delete}");
    expect(onDeleteSelected).toHaveBeenCalledOnce();
  });

  it("Delete is a no-op when nothing is selected", async () => {
    const onDeleteSelected = vi.fn();
    const screen = await render(
      <VirtualRuleList rules={[rule("r1")]} behavior={keyBehavior({ onDeleteSelected })} />,
    );
    (screen.getByRole("listbox").element() as HTMLElement).focus();
    await userEvent.keyboard("{Delete}");
    expect(onDeleteSelected).not.toHaveBeenCalled();
  });

  it("Escape clears an active selection", async () => {
    const onClearSelection = vi.fn();
    const screen = await render(
      <VirtualRuleList
        rules={[rule("r1")]}
        behavior={keyBehavior({ selectedIds: new Set(["r1"]), onClearSelection })}
      />,
    );
    (screen.getByRole("listbox").element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    expect(onClearSelection).toHaveBeenCalledOnce();
  });
});

describe("RuleBulkSelection", () => {
  it("names the count and wires the bulk delete / clear actions", async () => {
    const onDelete = vi.fn();
    const onClear = vi.fn();
    const screen = await render(
      <RuleBulkSelection count={4} onDelete={onDelete} onClear={onClear} />,
    );
    await expect.element(screen.getByText("4 rules selected")).toBeVisible();
    await screen.getByRole("button", { name: "Delete 4 rules" }).click();
    expect(onDelete).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Clear selection" }).click();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
