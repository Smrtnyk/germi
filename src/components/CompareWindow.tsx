import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { compact } from "es-toolkit";

import { api } from "../ipc";
import { onCompareSeedChanged } from "../compareWindow";
import { ToastHost, ToastProvider, useToasts } from "../toast";
import { CompareView } from "./CompareView";
import type { FlowSummary } from "../types";

interface ResolvedSeed {
  left: FlowSummary[];
  right: FlowSummary[];
}

/** Turn the mailbox's flow ids into live summaries, dropping ids the store no
 *  longer holds (evicted/deleted since the seed was written). */
async function resolveSeed(): Promise<ResolvedSeed | null> {
  const seed = await api.getCompareSeed();
  if (!seed) return null;
  const byId = new Map((await api.listFlows()).map((f) => [f.id, f]));
  return {
    left: compact(seed.left.map((id) => byId.get(id))),
    right: compact(seed.right.map((id) => byId.get(id))),
  };
}

/**
 * Root of the standalone compare window (issue #86), loaded by `main.tsx` when
 * the URL carries `?compare=1`. Reads the seed from the backend mailbox on
 * mount — and again whenever the main window re-seeds it (Compare invoked while
 * this window is already open), which resets the view via a fresh `key`.
 */
export function CompareWindow() {
  const toasts = useToasts();
  const notify = toasts.notify;
  const [seed, setSeed] = useState<ResolvedSeed | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await resolveSeed();
      if (request !== loadGeneration.current) return;
      setSeed(next);
      setGeneration((g) => g + 1);
    } catch (e) {
      if (request === loadGeneration.current) notify("error", String(e));
    } finally {
      if (request === loadGeneration.current) setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    // Install the event listener before taking the mailbox snapshot. Loading
    // first leaves a gap where a rapid re-seed is neither in that snapshot nor
    // observed as an event, stranding this window on the previous selection.
    void (async () => {
      try {
        const fn = await onCompareSeedChanged(() => void load());
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
        await load();
      } catch (error) {
        if (active) notify("error", String(error));
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [load, notify]);

  return (
    <ToastProvider value={notify}>
      {seed ? (
        <CompareView
          key={generation}
          initialLeft={seed.left}
          initialRight={seed.right}
          onClose={() => void getCurrentWindow().destroy()}
        />
      ) : (
        <div className="compare-window">
          <div className="diff-status muted">
            {loading
              ? "Loading…"
              : "Nothing to compare — select requests in the main window and choose Compare."}
          </div>
        </div>
      )}
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </ToastProvider>
  );
}
