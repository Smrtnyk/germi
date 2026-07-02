import { useEffect, useState } from "react";

import { api } from "../ipc";
import { headersToText } from "../curl";
import { requestLine, statusLine } from "../rawHttp";
import { flowUrl } from "../flowUrl";
import { statusCls } from "../filter";
import { isTypingTarget } from "../hotkey";
import { BodyDiffSection, DiffBlock, type DiffMode } from "./DiffView";
import type { BodyComparison, FlowDetail, FlowSummary, MessageDetail } from "../types";

const MODE_KEY = "germi.compareDiffMode";

function loadDiffMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
}

function useDiffMode() {
  const [mode, setMode] = useState<DiffMode>(loadDiffMode);
  function switchMode(next: DiffMode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }
  return { mode, switchMode };
}

function DiffModeSwitch({
  mode,
  onSwitch,
}: {
  mode: DiffMode;
  onSwitch: (mode: DiffMode) => void;
}) {
  return (
    <div className="seg diff-mode">
      <button className={mode === "split" ? "on" : ""} onClick={() => onSwitch("split")}>
        Side by side
      </button>
      <button className={mode === "unified" ? "on" : ""} onClick={() => onSwitch("unified")}>
        Unified
      </button>
    </div>
  );
}

function requestHead(d: FlowDetail): string {
  const headers = headersToText(d.request.headers);
  return headers ? `${requestLine(d)}\n${headers}` : requestLine(d);
}

function responseHead(d: FlowDetail): string {
  if (!d.response) return "(no response captured)";
  const headers = headersToText(d.response.headers);
  return headers ? `${statusLine(d)}\n${headers}` : statusLine(d);
}

/** Client-side fallback when the backend verdict is unavailable: exact only
 *  when neither display body was capped. */
function sideEquality(
  backend: boolean | null | undefined,
  a: MessageDetail | null,
  b: MessageDetail | null,
): boolean | null {
  if (backend != null) return backend;
  if (!a || !b || a.truncated || b.truncated) return null;
  return a.bodyText === b.bodyText && a.bodyBase64 === b.bodyBase64;
}

interface LoadedPair {
  a: FlowDetail;
  b: FlowDetail;
  cmp: BodyComparison | null;
}

function usePair(leftId: string, rightId: string) {
  const [pair, setPair] = useState<LoadedPair | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPair(null);
    setError(null);
    void Promise.all([
      api.getFlow(leftId, true, false),
      api.getFlow(rightId, true, false),
      api.compareFlowBodies(leftId, rightId),
    ])
      .then(([a, b, cmp]) => {
        if (!active) return;
        if (!a || !b) {
          setError("A compared request is no longer in the store (deleted or evicted).");
          return;
        }
        setPair({ a, b, cmp });
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [leftId, rightId]);

  return { pair, error };
}

function SideChip({ tag, flow }: { tag: string; flow: FlowSummary }) {
  return (
    <div className="diff-side-chip" title={flowUrl(flow)}>
      <span className="diff-side-tag">{tag}</span>
      <span className={`badge m-${flow.method.toLowerCase()}`}>{flow.method}</span>
      <span className={`multi-code ${statusCls(flow.status)}`}>{flow.status ?? "···"}</span>
      <span className="diff-side-url">{flowUrl(flow)}</span>
    </div>
  );
}

export interface CompareDiffProps {
  left: FlowSummary;
  right: FlowSummary;
}

/**
 * The diff screen of the compare view: raw-HTTP unified diffs of the request
 * and response heads, with bodies compared (backend, decoded bytes) but only
 * shown on demand. `B` toggles both body sections.
 */
export function CompareDiff({ left, right }: CompareDiffProps) {
  const { pair, error } = usePair(left.id, right.id);
  const { mode, switchMode } = useDiffMode();
  const [showReqBody, setShowReqBody] = useState(false);
  const [showRespBody, setShowRespBody] = useState(false);

  useEffect(() => {
    const toggleBoth = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      setShowReqBody((r) => {
        setShowRespBody(!r);
        return !r;
      });
    };
    window.addEventListener("keydown", toggleBoth);
    return () => window.removeEventListener("keydown", toggleBoth);
  }, []);

  if (error) return <div className="diff-status muted">{error}</div>;
  if (!pair) return <div className="diff-status muted">Loading both requests…</div>;

  const { a, b, cmp } = pair;
  return (
    <div className="diff-screen">
      <div className="diff-top">
        <div className="diff-sides">
          <SideChip tag="A" flow={left} />
          <SideChip tag="B" flow={right} />
        </div>
        <div className="spacer" />
        <DiffModeSwitch mode={mode} onSwitch={switchMode} />
      </div>
      <DiffBlock title="Request" a={requestHead(a)} b={requestHead(b)} mode={mode} />
      <BodyDiffSection
        label="Request body"
        a={a.request}
        b={b.request}
        equal={sideEquality(cmp?.requestEqual, a.request, b.request)}
        shown={showReqBody}
        onToggle={() => setShowReqBody((v) => !v)}
        mode={mode}
      />
      <DiffBlock title="Response" a={responseHead(a)} b={responseHead(b)} mode={mode} />
      <BodyDiffSection
        label="Response body"
        a={a.response}
        b={b.response}
        equal={sideEquality(cmp?.responseEqual, a.response, b.response)}
        shown={showRespBody}
        onToggle={() => setShowRespBody((v) => !v)}
        mode={mode}
      />
    </div>
  );
}
