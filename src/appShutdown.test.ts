import { describe, expect, it, vi } from "vitest";

import { runAppShutdown } from "./appShutdown";

function operations(step: (name: string) => Promise<void>) {
  return {
    closeSettings: () => step("settings"),
    closeScripts: () => step("scripts-window"),
    closeRules: () => step("rule-windows"),
    flushRuleEditor: () => step("rule-editor"),
    flushRuleMutations: () => step("rule-mutations"),
    flushHistory: () => step("history"),
    flushSettings: () => step("settings-store"),
    flushScripts: () => step("scripts-store"),
    destroyMain: () => step("main"),
  };
}

describe("app shutdown", () => {
  it("waits for Settings before flushing and destroying the main window", async () => {
    const order: string[] = [];
    await runAppShutdown(
      operations((name) => {
        order.push(name);
        return Promise.resolve();
      }),
    );

    expect(order).toEqual([
      "settings",
      "scripts-window",
      "rule-windows",
      "rule-editor",
      "rule-mutations",
      "history",
      "settings-store",
      "scripts-store",
      "main",
    ]);
  });

  it("leaves the app and its filter controller alive when dirty Settings cancels shutdown", async () => {
    const step = vi.fn((name: string) => {
      if (name === "settings") return Promise.reject(new Error("Settings has unsaved changes"));
      return Promise.resolve();
    });

    await expect(runAppShutdown(operations(step))).rejects.toThrow("unsaved changes");
    expect(step).toHaveBeenCalledOnce();
    expect(step).toHaveBeenCalledWith("settings");
  });
});
