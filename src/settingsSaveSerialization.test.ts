import { describe, expect, it, vi } from "vitest";

import { OrderedTaskQueue } from "./orderedTaskQueue";
import { settleSettingsWrite, type SettingsWriteResult } from "./settingsDraft";
import {
  bindSettingsPort,
  excludeSettingsHost,
  queueSettingsMutation,
  serializeSettingsDialogSave,
  type SettingsMutation,
} from "./settingsSaveSerialization";
import type { ProxySettings } from "./types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settings(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    excludedHosts: [],
    headerColumns: [],
    port: 8080,
    allowRemote: false,
    maxFlows: 5000,
    captureFilter: [],
    autoStartOnLaunch: true,
    responseDelayMs: 0,
    systemProxyHotkey: "",
    theme: "system",
    highlightColors: {},
    ...overrides,
  };
}

type DialogOutcome = "success" | "rejected-after-commit" | "genuine-failure";

interface RaceResult {
  baseline: ProxySettings;
  dialogDraft: ProxySettings;
  expected: ProxySettings;
  ui: ProxySettings;
  latest: ProxySettings;
  durable: ProxySettings;
  backend: ProxySettings;
  childBaseline: ProxySettings;
  childDraft: ProxySettings;
  childError: unknown | null;
  attemptedWrites: ProxySettings[];
  reconciled: [ProxySettings, ProxySettings][];
  generationAfterEnqueue: number;
  optimisticAfterEnqueue: ProxySettings;
}

interface RaceOptions {
  baseline?: Partial<ProxySettings>;
  dialog?: Partial<ProxySettings>;
}

/** Exercise the real producer shape: N is first applied optimistically to the
 * pre-M UI snapshot, then its field-level intent is evaluated again only when
 * the settings queue reaches it. */
async function runDialogMainMutationRace(
  outcome: DialogOutcome,
  mutation: SettingsMutation,
  options: RaceOptions = {},
): Promise<RaceResult> {
  const queue = new OrderedTaskQueue();
  const dialogStarted = deferred();
  const releaseDialog = deferred();
  const baseline = settings(options.baseline);
  const dialogDraft = {
    ...baseline,
    responseDelayMs: 750,
    theme: "light" as const,
    ...options.dialog,
  };
  let generation = 1;
  let ui = baseline;
  let latest = baseline;
  let durable = baseline;
  let backend = baseline;
  let childBaseline = baseline;
  let childDraft = dialogDraft;
  let childError: unknown | null = null;
  const attemptedWrites: ProxySettings[] = [];
  const reconciled: [ProxySettings, ProxySettings][] = [];

  const dialogSave = (async () => {
    try {
      await serializeSettingsDialogSave({
        queue,
        generation,
        currentGeneration: () => generation,
        commit: async () => {
          dialogStarted.resolve();
          await releaseDialog.promise;
          const result = await settleSettingsWrite(
            dialogDraft,
            () => {
              attemptedWrites.push(dialogDraft);
              if (outcome !== "genuine-failure") backend = dialogDraft;
              return outcome === "success"
                ? Promise.resolve()
                : Promise.reject(new Error(`dialog ${outcome}`));
            },
            () => Promise.resolve(backend),
          );
          const previous = durable;
          durable = result.settings;
          reconciled.push([previous, result.settings]);
          return { current: result.settings, rejection: result.rejection };
        },
        publishCurrent: (current) => {
          ui = current;
          latest = current;
        },
      });
      childBaseline = latest;
      childDraft = latest;
    } catch (error) {
      childError = error;
    }
  })();

  await dialogStarted.promise;

  // The main producer has not seen M: this is exactly the stale complete state
  // that used to be persisted and erase M after the queue unblocked.
  const mainSave = queueSettingsMutation({
    queue,
    nextGeneration: () => ++generation,
    currentGeneration: () => generation,
    getCurrent: () => latest,
    publishOptimistic: (current) => {
      ui = current;
      latest = current;
    },
    getDurable: () => durable,
    mutation,
    commit: (_previous, attempted) => {
      attemptedWrites.push(attempted);
      return settleSettingsWrite(
        attempted,
        () => {
          backend = attempted;
          return Promise.resolve();
        },
        () => Promise.resolve(backend),
      );
    },
    acceptDurable: (result: SettingsWriteResult) => {
      durable = result.settings;
    },
    publishCurrent: (current) => {
      ui = current;
      latest = current;
    },
    reconcile: (previous, current) => {
      reconciled.push([previous, current]);
      return Promise.resolve();
    },
  });
  expect(latest.responseDelayMs).toBe(0);
  const generationAfterEnqueue = generation;
  const optimisticAfterEnqueue = latest;

  releaseDialog.resolve();
  await mainSave.result;
  await dialogSave;

  const baseForMutation = outcome === "genuine-failure" ? baseline : dialogDraft;
  return {
    baseline,
    dialogDraft,
    expected: mutation(baseForMutation),
    ui,
    latest,
    durable,
    backend,
    childBaseline,
    childDraft,
    childError,
    attemptedWrites,
    reconciled,
    generationAfterEnqueue,
    optimisticAfterEnqueue,
  };
}

describe("settings save serialization", () => {
  it.each(["success", "rejected-after-commit"] as const)(
    "rebases an exclude-host producer onto dialog M after %s and converges every owner",
    async (outcome) => {
      const result = await runDialogMainMutationRace(
        outcome,
        excludeSettingsHost("api.example.test"),
      );

      expect(result.ui).toEqual(result.expected);
      expect(result.latest).toEqual(result.expected);
      expect(result.durable).toEqual(result.expected);
      expect(result.backend).toEqual(result.expected);
      expect(result.childBaseline).toEqual(result.expected);
      expect(result.childDraft).toEqual(result.expected);
      expect(result.childError).toBeNull();
      expect(result.expected).toMatchObject({
        excludedHosts: ["api.example.test"],
        responseDelayMs: 750,
        theme: "light",
      });
      expect(result.attemptedWrites).toEqual([result.dialogDraft, result.expected]);
      expect(result.reconciled).toEqual([
        [result.baseline, result.dialogDraft],
        [result.dialogDraft, result.expected],
      ]);
    },
  );

  it("rebases exclusion onto authoritative B after a genuine M failure without resurrecting M", async () => {
    const result = await runDialogMainMutationRace(
      "genuine-failure",
      excludeSettingsHost("api.example.test"),
    );

    expect(result.ui).toEqual(result.expected);
    expect(result.latest).toEqual(result.expected);
    expect(result.durable).toEqual(result.expected);
    expect(result.backend).toEqual(result.expected);
    expect(result.expected).toMatchObject({
      excludedHosts: ["api.example.test"],
      responseDelayMs: 0,
      theme: "system",
    });
    expect(result.childBaseline).toEqual(result.baseline);
    expect(result.childDraft).toEqual(result.dialogDraft);
    expect(result.childError).toEqual(new Error("dialog genuine-failure"));
    expect(result.attemptedWrites).toEqual([result.dialogDraft, result.expected]);
    expect(result.reconciled).toEqual([
      [result.baseline, result.baseline],
      [result.baseline, result.expected],
    ]);
  });

  it("rebases both runtime and startup port-bound producers at queue execution time", async () => {
    for (const boundPort of [9090, 7070]) {
      const result = await runDialogMainMutationRace("success", bindSettingsPort(boundPort));

      expect(result.ui).toEqual(result.expected);
      expect(result.latest).toEqual(result.expected);
      expect(result.durable).toEqual(result.expected);
      expect(result.backend).toEqual(result.expected);
      expect(result.childBaseline).toEqual(result.expected);
      expect(result.childError).toBeNull();
      expect(result.expected).toMatchObject({
        port: boundPort,
        responseDelayMs: 750,
        theme: "light",
      });
      expect(result.attemptedWrites).toEqual([result.dialogDraft, result.expected]);
    }
  });

  it.each(["success", "rejected-after-commit", "genuine-failure"] as const)(
    "does not lose a later exclusion that is an enqueue-time no-op when M has %s",
    async (outcome) => {
      const host = "already.test";
      const result = await runDialogMainMutationRace(outcome, excludeSettingsHost(host), {
        baseline: { excludedHosts: [host] },
        dialog: { excludedHosts: [] },
      });

      expect(result.generationAfterEnqueue).toBe(2);
      expect(result.optimisticAfterEnqueue).toBe(result.baseline);
      expect(result.expected.excludedHosts).toEqual([host]);
      expect(result.ui).toEqual(result.expected);
      expect(result.latest).toEqual(result.expected);
      expect(result.durable).toEqual(result.expected);
      expect(result.backend).toEqual(result.expected);

      if (outcome === "genuine-failure") {
        expect(result.expected).toEqual(result.baseline);
        expect(result.childBaseline).toEqual(result.baseline);
        expect(result.childDraft).toEqual(result.dialogDraft);
        expect(result.childError).toEqual(new Error("dialog genuine-failure"));
        expect(result.attemptedWrites).toEqual([result.dialogDraft]);
        expect(result.reconciled).toEqual([[result.baseline, result.baseline]]);
      } else {
        expect(result.expected).toMatchObject({ responseDelayMs: 750, theme: "light" });
        expect(result.childBaseline).toEqual(result.expected);
        expect(result.childDraft).toEqual(result.expected);
        expect(result.childError).toBeNull();
        expect(result.attemptedWrites).toEqual([result.dialogDraft, result.expected]);
        expect(result.reconciled).toEqual([
          [result.baseline, result.dialogDraft],
          [result.dialogDraft, result.expected],
        ]);
      }
    },
  );

  it.each(["success", "rejected-after-commit", "genuine-failure"] as const)(
    "does not lose a later bound-port report that is an enqueue-time no-op when M has %s",
    async (outcome) => {
      const result = await runDialogMainMutationRace(outcome, bindSettingsPort(8080), {
        baseline: { port: 8080 },
        dialog: { port: 9090 },
      });

      expect(result.generationAfterEnqueue).toBe(2);
      expect(result.optimisticAfterEnqueue).toBe(result.baseline);
      expect(result.expected.port).toBe(8080);
      expect(result.ui).toEqual(result.expected);
      expect(result.latest).toEqual(result.expected);
      expect(result.durable).toEqual(result.expected);
      expect(result.backend).toEqual(result.expected);

      if (outcome === "genuine-failure") {
        expect(result.expected).toEqual(result.baseline);
        expect(result.childBaseline).toEqual(result.baseline);
        expect(result.childDraft).toEqual(result.dialogDraft);
        expect(result.childError).toEqual(new Error("dialog genuine-failure"));
        expect(result.attemptedWrites).toEqual([result.dialogDraft]);
      } else {
        expect(result.expected).toMatchObject({ responseDelayMs: 750, theme: "light" });
        expect(result.childBaseline).toEqual(result.expected);
        expect(result.childDraft).toEqual(result.expected);
        expect(result.childError).toBeNull();
        expect(result.attemptedWrites).toEqual([result.dialogDraft, result.expected]);
      }
    },
  );

  it("enqueues a harmless no-op even when current and durable already contain the field", async () => {
    const queue = new OrderedTaskQueue();
    const current = settings({ excludedHosts: ["already.test"] });
    let generation = 1;
    const commit = vi.fn();
    const publishOptimistic = vi.fn();
    const publishCurrent = vi.fn();

    const scheduled = queueSettingsMutation({
      queue,
      nextGeneration: () => ++generation,
      currentGeneration: () => generation,
      getCurrent: () => current,
      publishOptimistic,
      getDurable: () => current,
      mutation: excludeSettingsHost("already.test"),
      commit,
      acceptDurable: vi.fn(),
      publishCurrent,
      reconcile: vi.fn(),
    });

    expect(generation).toBe(2);
    expect(publishOptimistic).toHaveBeenCalledWith(current);
    await expect(scheduled.result).resolves.toBe(current);
    expect(commit).not.toHaveBeenCalled();
    expect(publishCurrent).toHaveBeenCalledWith(current);
  });

  it("converges without another write when the intent is already present at execution time", async () => {
    const queue = new OrderedTaskQueue();
    const stale = settings();
    const authoritative = settings({ excludedHosts: ["already.test"] });
    const commit = vi.fn();
    const publishOptimistic = vi.fn();
    const publishCurrent = vi.fn();

    const scheduled = queueSettingsMutation({
      queue,
      nextGeneration: () => 2,
      currentGeneration: () => 2,
      getCurrent: () => stale,
      publishOptimistic,
      getDurable: () => authoritative,
      mutation: excludeSettingsHost("already.test"),
      commit,
      acceptDurable: vi.fn(),
      publishCurrent,
      reconcile: vi.fn(),
    });

    await expect(scheduled.result).resolves.toEqual(authoritative);
    expect(publishOptimistic).toHaveBeenCalledWith(authoritative);
    expect(publishCurrent).toHaveBeenCalledWith(authoritative);
    expect(commit).not.toHaveBeenCalled();
  });
});
