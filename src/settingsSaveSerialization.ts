import { isEqual } from "es-toolkit";

import type { OrderedTaskQueue } from "./orderedTaskQueue";
import type { SettingsWriteResult } from "./settingsDraft";
import type { ProxySettings } from "./types";

export type SettingsMutation = (current: ProxySettings) => ProxySettings;

/**
 * The proxy can report the port it actually bound while another settings save
 * is still in flight. Keep that report as a field-level intent: turning it into
 * a complete snapshot at event time would copy every other field from stale UI
 * state and overwrite the in-flight save when this operation reaches the queue.
 */
export function bindSettingsPort(port: number): SettingsMutation {
  return (current) => (current.port === port ? current : { ...current, port });
}

/** See {@link bindSettingsPort}. Context-menu exclusion is another main-owned
 * field mutation that must be applied to the authoritative queue-time state. */
export function excludeSettingsHost(host: string): SettingsMutation {
  return (current) =>
    current.excludedHosts.includes(host)
      ? current
      : { ...current, excludedHosts: [...current.excludedHosts, host] };
}

interface SerializedSettingsMutationOptions {
  queue: OrderedTaskQueue;
  generation: number;
  currentGeneration: () => number;
  getDurable: () => ProxySettings;
  mutation: SettingsMutation;
  commit: (previous: ProxySettings, attempted: ProxySettings) => Promise<SettingsWriteResult>;
  acceptDurable: (result: SettingsWriteResult) => void;
  publishCurrent: (current: ProxySettings) => void;
  reconcile: (previous: ProxySettings, current: ProxySettings) => Promise<void>;
}

interface QueueSettingsMutationOptions extends Omit<
  SerializedSettingsMutationOptions,
  "generation"
> {
  nextGeneration: () => number;
  getCurrent: () => ProxySettings;
  publishOptimistic: (current: ProxySettings) => void;
}

export interface QueuedSettingsMutation {
  generation: number;
  result: Promise<ProxySettings>;
}

/** Start the real main-window producer path. The optimistic projection is for
 * responsiveness only; the same intent is independently rebased at the queue
 * execution point by {@link serializeSettingsMutation}. */
export function queueSettingsMutation({
  nextGeneration,
  getCurrent,
  publishOptimistic,
  ...serialization
}: QueueSettingsMutationOptions): QueuedSettingsMutation {
  const current = getCurrent();
  const optimistic = serialization.mutation(current);
  // Equality against the current/optimistic snapshot cannot prove this intent
  // is a no-op: an already-enqueued full save may change the same field before
  // this task executes. Always establish ordering + generation ownership, then
  // decide against the authoritative durable output of every predecessor.
  const generation = nextGeneration();
  publishOptimistic(optimistic);
  return {
    generation,
    result: serializeSettingsMutation({ ...serialization, generation }),
  };
}

/**
 * Execute a main-owned field mutation against the durable result of every
 * earlier queued save, rather than the render/optimistic snapshot that existed
 * when the event arrived. This is the queue's linearization point: a preceding
 * full Settings save can succeed, be confirmed by readback after a rejected
 * command, or genuinely roll back, and the mutation is rebased onto that exact
 * authoritative outcome in all three cases.
 */
function serializeSettingsMutation({
  queue,
  generation,
  currentGeneration,
  getDurable,
  mutation,
  commit,
  acceptDurable,
  publishCurrent,
  reconcile,
}: SerializedSettingsMutationOptions): Promise<ProxySettings> {
  return queue.run(async () => {
    const previous = getDurable();
    const attempted = mutation(previous);
    if (isEqual(attempted, previous)) {
      if (currentGeneration() === generation) publishCurrent(previous);
      return previous;
    }

    const result = await commit(previous, attempted);
    acceptDurable(result);
    if (currentGeneration() === generation) publishCurrent(result.settings);
    await reconcile(previous, result.settings);
    if (result.rejection !== null) throw result.rejection;
    return result.settings;
  });
}

interface SerializedDialogSaveResult<T> {
  current: T;
  rejection: unknown | null;
}

interface SerializedDialogSaveOptions<T> {
  queue: OrderedTaskQueue;
  generation: number;
  currentGeneration: () => number;
  commit: () => Promise<SerializedDialogSaveResult<T>>;
  publishCurrent: (current: T) => void;
}

/**
 * Run a Settings-window save in the main settings queue without letting its
 * older completion replace a newer optimistic main-window mutation. The queue
 * is drained even after failure so the caller's readback observes every save
 * that was initiated while this transaction was awaiting I/O.
 */
export async function serializeSettingsDialogSave<T>({
  queue,
  generation,
  currentGeneration,
  commit,
  publishCurrent,
}: SerializedDialogSaveOptions<T>): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await queue.run(async () => {
      const result = await commit();
      if (currentGeneration() === generation) publishCurrent(result.current);
      if (result.rejection !== null) throw result.rejection;
    });
  } catch (error) {
    failed = true;
    failure = error;
  }

  await queue.flush();
  if (failed) {
    const normalized =
      failure instanceof Error
        ? failure
        : Object.assign(new Error(String(failure)), { cause: failure });
    throw normalized;
  }
}
