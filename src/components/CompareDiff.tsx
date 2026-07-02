import { useEffect, useState } from "react";

import { api } from "../ipc";
import { headersToText } from "../curl";
import { requestLine, statusLine } from "../rawHttp";
import { flowUrl } from "../flowUrl";
import { statusCls } from "../filter";
import { BodyDiffSection, DiffBlock } from "./DiffView";
import type { BodyComparison, FlowDetail, FlowSummary, MessageDetail } from "../types";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
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
      <div className="diff-sides">
        <SideChip tag="A" flow={left} />
        <SideChip tag="B" flow={right} />
      </div>
      <DiffBlock title="Request" a={requestHead(a)} b={requestHead(b)} />
      <BodyDiffSection
        label="Request body"
        a={a.request}
        b={b.request}
        equal={sideEquality(cmp?.requestEqual, a.request, b.request)}
        shown={showReqBody}
        onToggle={() => setShowReqBody((v) => !v)}
      />
      <DiffBlock title="Response" a={responseHead(a)} b={responseHead(b)} />
      <BodyDiffSection
        label="Response body"
        a={a.response}
        b={b.response}
        equal={sideEquality(cmp?.responseEqual, a.response, b.response)}
        shown={showRespBody}
        onToggle={() => setShowRespBody((v) => !v)}
      />
    </div>
  );
}
