import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSeed(await resolveSeed());
      setGeneration((g) => g + 1);
    } catch (e) {
      notify("error", String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    let active = true;
    let unlisten: (() => void) | undefined;
    void onCompareSeedChanged(() => void load()).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [load]);

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
