import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";

import type { HistoryTag, Rule, RuleSummary } from "../types";
import { useSelectedRule } from "./AutoresponderPanel";

function rule(url = "/start"): Rule {
  return {
    id: "r1",
    enabled: true,
    fireLimit: null,
    repeat: false,
    matcher: { method: "GET", url, urlMatch: "exact" },
    action: {
      kind: "respond",
      status: 200,
      headers: [],
      body: "ok",
      contentType: "text/plain",
      contentEncoding: null,
    },
  };
}

function summary(value: Rule): RuleSummary {
  return {
    id: value.id,
    enabled: value.enabled,
    fireLimit: value.fireLimit,
    repeat: value.repeat,
    matcher: value.matcher,
    action: {
      kind: "respond",
      status: 200,
      contentType: "text/plain",
      contentEncoding: null,
    },
  };
}

async function loadedHook(
  update: (scenarioId: string, value: Rule, tag?: HistoryTag) => Promise<RuleSummary | null>,
) {
  const hook = await renderHook(() =>
    useSelectedRule("scenario", "r1", () => Promise.resolve(rule()), update),
  );
  await vi.waitFor(() => expect(hook.result.current.rule?.matcher.url).toBe("/start"));
  return hook;
}

function SelectionHarness({
  selectedRuleId,
  load,
  update,
}: {
  selectedRuleId: string;
  load: (ruleId: string) => Promise<Rule | null>;
  update: (scenarioId: string, value: Rule, tag?: HistoryTag) => Promise<RuleSummary | null>;
}) {
  const state = useSelectedRule("scenario", selectedRuleId, load, update);
  return <output>{`${state.loading ? "loading" : "idle"}:${state.rule?.id ?? "none"}`}</output>;
}

afterEach(() => vi.useRealTimers());

describe("useSelectedRule persistence", () => {
  it("stops exposing the old rule while a new selection loads", async () => {
    let resolveSecond!: (value: Rule) => void;
    const second = new Promise<Rule>((resolve) => {
      resolveSecond = resolve;
    });
    const load = vi.fn((id: string) => {
      if (id === "r1") return Promise.resolve(rule());
      return second;
    });
    const update = vi.fn((_scenarioId: string, value: Rule) => Promise.resolve(summary(value)));
    const screen = await render(
      <SelectionHarness selectedRuleId="r1" load={load} update={update} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("idle:r1");

    await screen.rerender(<SelectionHarness selectedRuleId="r2" load={load} update={update} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("loading:none");

    resolveSecond({ ...rule("/second"), id: "r2" });
    await expect.element(screen.getByRole("status")).toHaveTextContent("idle:r2");
  });

  it("serializes a newer edit behind an in-flight autosave", async () => {
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const update = vi.fn(async (_scenarioId: string, value: Rule) => {
      calls.push(value.matcher.url);
      if (value.matcher.url === "/one") await blocked;
      return summary(value);
    });
    const { result } = await loadedHook(update);
    vi.useFakeTimers();

    result.current.patch({ matcher: { ...result.current.rule!.matcher, url: "/one" } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(calls).toEqual(["/one"]));

    result.current.patch({ matcher: { ...result.current.rule!.matcher, url: "/two" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual(["/one"]);
    releaseFirst();
    await result.current.flush();

    expect(calls).toEqual(["/one", "/two"]);
  });

  it("retains a failed autosave for an explicit flush retry", async () => {
    const update = vi
      .fn<(scenarioId: string, value: Rule) => Promise<RuleSummary | null>>()
      .mockResolvedValueOnce(null)
      .mockImplementation((_scenarioId, value) => Promise.resolve(summary(value)));
    const { result } = await loadedHook(update);
    vi.useFakeTimers();

    result.current.patch({ matcher: { ...result.current.rule!.matcher, url: "/retry" } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await result.current.flush();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1].matcher.url).toBe("/retry");
  });

  it("persists the typed snapshot before a discrete history action", async () => {
    const calls: Array<{ url: string; tag?: HistoryTag }> = [];
    const update = vi.fn((_scenarioId: string, value: Rule, tag?: HistoryTag) => {
      calls.push({ url: value.matcher.url, tag });
      return Promise.resolve(summary(value));
    });
    const { result } = await loadedHook(update);
    vi.useFakeTimers();

    result.current.patch({ matcher: { ...result.current.rule!.matcher, url: "/typed" } });
    await vi.waitFor(() => expect(result.current.rule?.matcher.url).toBe("/typed"));
    const tag = { label: "Format rule" };
    result.current.patch({ matcher: { ...result.current.rule!.matcher, url: "/formatted" } }, tag);
    await result.current.flush();

    expect(calls).toEqual([
      { url: "/typed", tag: undefined },
      { url: "/formatted", tag },
    ]);
  });
});
