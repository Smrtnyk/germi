import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FlowDetail, FlowSummary, MessageDetail } from "../types";
import { useToast } from "../toast";
import { useCopy } from "../useCopy";
import { useResizable } from "../useResizable";
import { headersToText, parseCookies, parseQuery, toCurl, type KV } from "../curl";
import { MaximizedOverlay } from "./MaximizedOverlay";

const ROW_H = 18;
const MAX_ROW = 2000;
const PRETTY_CAP = 512 * 1024;

function toRows(text: string): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= MAX_ROW) rows.push(line);
    else pushChunks(line, rows);
  }
  return rows.length ? rows : [""];
}

function pushChunks(line: string, rows: string[]): void {
  let i = 0;
  while (i < line.length) {
    let end = Math.min(i + MAX_ROW, line.length);
    const last = line.charCodeAt(end - 1);
    if (end < line.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    rows.push(line.slice(i, end));
    i = end;
  }
}

function highlight(line: string, query: string): ReactNode {
  if (!query) return line === "" ? " " : line;
  const lc = line.toLowerCase();
  const q = query.toLowerCase();
  const nodes: ReactNode[] = [];
  let from = 0;
  let key = 0;
  let i = lc.indexOf(q, from);
  if (i === -1) return line;
  while (i !== -1) {
    if (i > from) nodes.push(line.slice(from, i));
    nodes.push(
      <mark key={key++} className="vmatch">
        {line.slice(i, i + query.length)}
      </mark>,
    );
    from = i + query.length;
    i = lc.indexOf(q, from);
  }
  if (from < line.length) nodes.push(line.slice(from));
  return nodes;
}

type Virtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;

function useFind(
  rows: string[],
  query: string,
  findOpen: boolean | undefined,
  virtualizer: Virtualizer,
) {
  const findRef = useRef<HTMLInputElement>(null);
  const [idx, setIdx] = useState(0);

  const matches = useMemo(() => {
    if (query.length < 1) return [];
    const q = query.toLowerCase();
    const res: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].toLowerCase().includes(q)) res.push(i);
      if (res.length >= 5000) break;
    }
    return res;
  }, [rows, query]);

  useEffect(() => setIdx(0), [query]);
  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (findOpen && matches.length) {
      virtualizer.scrollToIndex(matches[Math.min(idx, matches.length - 1)], { align: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, matches, findOpen]);

  const activeLine = matches.length ? matches[Math.min(idx, matches.length - 1)] : -1;
  const step = (dir: number) => {
    if (matches.length) setIdx((i) => (i + dir + matches.length) % matches.length);
  };

  return { findRef, idx, matches, activeLine, step };
}

function FindBar({
  findRef,
  query,
  setQuery,
  idx,
  matches,
  step,
  onCloseFind,
}: {
  findRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (q: string) => void;
  idx: number;
  matches: number[];
  step: (dir: number) => void;
  onCloseFind?: () => void;
}) {
  return (
    <div className="vfind">
      <input
        ref={findRef}
        value={query}
        placeholder="Find in body"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") onCloseFind?.();
        }}
      />
      <span className="vfind-count">
        {query
          ? matches.length
            ? `${Math.min(idx + 1, matches.length)}/${matches.length}`
            : "0/0"
          : ""}
      </span>
      <button
        className="btn ghost"
        title="Previous (Shift+Enter)"
        onClick={() => step(-1)}
        disabled={!matches.length}
      >
        ↑
      </button>
      <button
        className="btn ghost"
        title="Next (Enter)"
        onClick={() => step(1)}
        disabled={!matches.length}
      >
        ↓
      </button>
      <button className="btn ghost" title="Close (Esc)" onClick={onCloseFind}>
        ✕
      </button>
    </div>
  );
}

function VLine({
  line,
  index,
  start,
  size,
  query,
  wrap,
  activeLine,
  measureElement,
}: {
  line: string;
  index: number;
  start: number;
  size: number;
  query: string;
  wrap: boolean | undefined;
  activeLine: number;
  measureElement: Virtualizer["measureElement"];
}) {
  const isHit = query.length > 0 && line.toLowerCase().includes(query.toLowerCase());
  return (
    <div
      data-index={index}
      ref={wrap ? measureElement : undefined}
      className={`vline ${isHit ? "hit" : ""} ${index === activeLine ? "active" : ""}`}
      style={
        wrap
          ? { transform: `translateY(${start}px)` }
          : { transform: `translateY(${start}px)`, height: size }
      }
    >
      {query ? highlight(line, query) : line === "" ? " " : line}
    </div>
  );
}

/** Virtualized text viewer with optional find bar and word-wrap. */
function VirtualText({
  text,
  hex,
  wrap,
  findOpen,
  onCloseFind,
}: {
  text: string;
  hex?: boolean;
  wrap?: boolean;
  findOpen?: boolean;
  onCloseFind?: () => void;
}) {
  const rows = useMemo(() => toRows(text), [text]);
  const parentRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 40,
  });

  const { findRef, idx, matches, activeLine, step } = useFind(rows, query, findOpen, virtualizer);

  return (
    <div className={`vtext ${hex ? "hex" : ""} ${wrap ? "wrap" : ""}`}>
      {findOpen && (
        <FindBar
          findRef={findRef}
          query={query}
          setQuery={setQuery}
          idx={idx}
          matches={matches}
          step={step}
          onCloseFind={onCloseFind}
        />
      )}
      <div ref={parentRef} className="vtext-scroll">
        <div className="vtext-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <VLine
              key={item.index}
              line={rows[item.index]}
              index={item.index}
              start={item.start}
              size={item.size}
              query={query}
              wrap={wrap}
              activeLine={activeLine}
              measureElement={virtualizer.measureElement}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SingleProps {
  detail: FlowDetail | null;
  summary: FlowSummary | undefined;
  loading: boolean;
  onMock: (detail: FlowDetail) => void;
  decode: boolean;
  onLoadFull: () => void;
}

interface Props extends SingleProps {
  selectedSummaries: FlowSummary[];
  onSelectOne: (id: string) => void;
  onMockMany: (ids: string[]) => void;
  onClearSelection: () => void;
}

type Side = "request" | "response";
type BodyView = "pretty" | "raw";

function contentType(headers: [string, string][]): string {
  return (headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function classify(ct: string, text: string): "image" | "text" | "binary" {
  if (ct.startsWith("image/")) return ct.includes("svg") ? "text" : "image";
  if (
    ct.startsWith("text/") ||
    /(json|javascript|ecmascript|xml|x-www-form-urlencoded|csv|html|graphql)/.test(ct)
  ) {
    return "text";
  }
  if (
    ct.startsWith("font/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    /(octet-stream|pdf|zip|gzip|wasm|protobuf|msgpack|woff|ttf|otf)/.test(ct)
  ) {
    return "binary";
  }
  const sample = text.slice(0, 2000);
  if (!sample) return "text";
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad / sample.length > 0.08 ? "binary" : "text";
}

function prettify(ct: string, text: string): { pretty: string; canPretty: boolean } {
  if (text.length > PRETTY_CAP) return { pretty: text, canPretty: false };
  if (ct.includes("json")) {
    try {
      return { pretty: JSON.stringify(JSON.parse(text), null, 2), canPretty: true };
    } catch {
      return { pretty: text, canPretty: false };
    }
  }
  if (ct.includes("x-www-form-urlencoded") && text.includes("=")) {
    const lines = text.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? "" : pair.slice(eq + 1);
      try {
        return `${decodeURIComponent(k)} = ${decodeURIComponent(v)}`;
      } catch {
        return `${k} = ${v}`;
      }
    });
    return { pretty: lines.join("\n"), canPretty: true };
  }
  return { pretty: text, canPretty: false };
}

function hexDump(b64: string, maxBytes = 64 * 1024): string {
  let bin: string;
  try {
    bin = atob(b64.slice(0, Math.ceil(maxBytes / 3) * 4));
  } catch {
    return "(unable to decode body)";
  }
  const n = Math.min(bin.length, maxBytes);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const chunk = bin.slice(i, i + 16);
    let hex = "";
    let ascii = "";
    for (let j = 0; j < chunk.length; j++) {
      const c = chunk.charCodeAt(j);
      hex += c.toString(16).padStart(2, "0") + " ";
      ascii += c >= 32 && c < 127 ? chunk[j] : ".";
    }
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48)} ${ascii}`);
  }
  return lines.join("\n");
}

function bodyKind(msg: MessageDetail, ct: string, decode: boolean): "image" | "text" | "binary" {
  if (msg.size === 0) return "text";
  if (msg.encoding && !msg.decoded) return "binary";
  if (!decode && msg.encoding) return "binary";
  return classify(ct, msg.bodyText);
}

function encodingLabel(msg: MessageDetail, decode: boolean): string | null {
  if (!msg.encoding) return null;
  if (msg.decoded) return `${msg.encoding} · decoded`;
  return `${msg.encoding}${decode ? " · failed" : " · raw"}`;
}

function KvTable({ label, rows }: { label: string; rows: KV[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="kv-block">
      <div className="kv-label">
        {label} <span className="muted">· {rows.length}</span>
      </div>
      <div className="headers">
        {rows.map((r, i) => (
          <div className="hrow" key={`${r.key}-${i}`}>
            <span className="hkey">{r.key}</span>
            <span className="hval">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageHeaders({ headers }: { headers: [string, string][] }) {
  return (
    <div className="headers">
      {headers.map(([k, v], i) => (
        <div className="hrow" key={`${k}-${i}`}>
          <span className="hkey">{k}</span>
          <span className="hval">{v}</span>
        </div>
      ))}
      {headers.length === 0 && <div className="muted">No headers</div>}
    </div>
  );
}

function ImageBody({ msg, ct }: { msg: MessageDetail; ct: string }) {
  if (msg.truncated) {
    return (
      <div className="binary-note">
        <span className="muted">
          Image · {fmtSize(msg.size)} — too large to preview. Load the full body to view it.
        </span>
      </div>
    );
  }
  return (
    <div className="img-wrap">
      <img
        className="img-preview"
        src={`data:${ct || "image/png"};base64,${msg.bodyBase64}`}
        alt="response preview"
      />
    </div>
  );
}

function BinaryBody({
  msg,
  ct,
  isRawEncoded,
  showHex,
}: {
  msg: MessageDetail;
  ct: string;
  isRawEncoded: boolean;
  showHex: boolean;
}) {
  const hex = useMemo(() => hexDump(msg.bodyBase64), [msg.bodyBase64]);
  return (
    <div className="binary-note">
      <span className="muted">
        {isRawEncoded
          ? `Raw ${msg.encoding} body · ${fmtSize(msg.size)} — turn Decode on to read it.`
          : `Binary content${ct ? ` · ${ct}` : ""} · ${fmtSize(msg.size)} — not shown as text.`}
      </span>
      {showHex && <VirtualText text={hex} hex />}
    </div>
  );
}

function MessageBody({
  msg,
  kind,
  ct,
  text,
  wrap,
  findOpen,
  onCloseFind,
  isRawEncoded,
  showHex,
}: {
  msg: MessageDetail;
  kind: "image" | "text" | "binary";
  ct: string;
  text: string;
  wrap: boolean;
  findOpen: boolean;
  onCloseFind: () => void;
  isRawEncoded: boolean;
  showHex: boolean;
}) {
  if (msg.size === 0) {
    return (
      <pre className="body">
        <span className="muted">(empty)</span>
      </pre>
    );
  }
  if (kind === "image") return <ImageBody msg={msg} ct={ct} />;
  if (kind === "binary") {
    return <BinaryBody msg={msg} ct={ct} isRawEncoded={isRawEncoded} showHex={showHex} />;
  }
  return <VirtualText text={text} wrap={wrap} findOpen={findOpen} onCloseFind={onCloseFind} />;
}

function useBodyState() {
  const [view, setView] = useState<BodyView>("pretty");
  const [showHex, setShowHex] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  return { view, setView, showHex, setShowHex, wrap, setWrap, findOpen, setFindOpen };
}

function MetaPanel({
  msg,
  side,
  query,
  cookies,
  copy,
  style,
}: {
  msg: MessageDetail;
  side: Side;
  query: KV[];
  cookies: KV[];
  copy: (label: string, value: string) => void;
  style?: CSSProperties;
}) {
  return (
    <div className="meta-scroll" style={style}>
      <KvTable label="Query string" rows={query} />
      <KvTable label={side === "request" ? "Cookies" : "Set-Cookie"} rows={cookies} />
      <div className="kv-block">
        <div className="kv-label">
          Headers <span className="muted">· {msg.headers.length}</span>
          <button
            className="btn ghost small kv-copy"
            title="Copy headers"
            onClick={() => copy("Headers", headersToText(msg.headers))}
          >
            ⧉
          </button>
        </div>
        <MessageHeaders headers={msg.headers} />
      </div>
    </div>
  );
}

function PrettyRawToggle({ view, setView }: { view: BodyView; setView: (v: BodyView) => void }) {
  return (
    <div className="seg">
      <button className={view === "pretty" ? "on" : ""} onClick={() => setView("pretty")}>
        Pretty
      </button>
      <button className={view === "raw" ? "on" : ""} onClick={() => setView("raw")}>
        Raw
      </button>
    </div>
  );
}

function HexToggle({
  showHex,
  setShowHex,
}: {
  showHex: boolean;
  setShowHex: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="seg">
      <button className={showHex ? "on" : ""} onClick={() => setShowHex((s) => !s)}>
        Hex
      </button>
    </div>
  );
}

function TextActions({
  wrap,
  setWrap,
  findOpen,
  setFindOpen,
}: {
  wrap: boolean;
  setWrap: React.Dispatch<React.SetStateAction<boolean>>;
  findOpen: boolean;
  setFindOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      <button
        className={wrap ? "btn active small" : "btn ghost small"}
        title="Toggle word wrap"
        onClick={() => setWrap((w) => !w)}
      >
        Wrap
      </button>
      <button
        className={findOpen ? "btn active small" : "btn ghost small"}
        title="Find in body"
        onClick={() => setFindOpen((f) => !f)}
      >
        Find
      </button>
    </>
  );
}

function BodyBar({
  msg,
  kind,
  encLabel,
  canPretty,
  view,
  setView,
  showHex,
  setShowHex,
  wrap,
  setWrap,
  findOpen,
  setFindOpen,
  copy,
  onMaximize,
}: {
  msg: MessageDetail;
  kind: "image" | "text" | "binary";
  encLabel: string | null;
  canPretty: boolean;
  view: BodyView;
  setView: (v: BodyView) => void;
  showHex: boolean;
  setShowHex: React.Dispatch<React.SetStateAction<boolean>>;
  wrap: boolean;
  setWrap: React.Dispatch<React.SetStateAction<boolean>>;
  findOpen: boolean;
  setFindOpen: React.Dispatch<React.SetStateAction<boolean>>;
  copy: (label: string, value: string) => void;
  onMaximize?: () => void;
}) {
  return (
    <div className="body-bar">
      <span className="body-meta">
        <span className="muted">Body · {fmtSize(msg.size)}</span>
        {encLabel && <span className="enc-chip">{encLabel}</span>}
      </span>
      <div className="body-actions">
        {kind === "text" && canPretty && <PrettyRawToggle view={view} setView={setView} />}
        {kind === "binary" && <HexToggle showHex={showHex} setShowHex={setShowHex} />}
        {kind === "text" && (
          <TextActions
            wrap={wrap}
            setWrap={setWrap}
            findOpen={findOpen}
            setFindOpen={setFindOpen}
          />
        )}
        <button
          className="btn ghost small"
          title="Copy body"
          onClick={() => copy("Body", msg.bodyText)}
        >
          Copy body
        </button>
        {onMaximize && (
          <button className="btn ghost small" title="Maximize (full view)" onClick={onMaximize}>
            ⤢
          </button>
        )}
      </div>
    </div>
  );
}

function MessageView({
  msg,
  side,
  path,
  decode,
  onLoadFull,
}: {
  msg: MessageDetail;
  side: Side;
  path: string;
  decode: boolean;
  onLoadFull: () => void;
}) {
  const copy = useCopy();
  const { view, setView, showHex, setShowHex, wrap, setWrap, findOpen, setFindOpen } =
    useBodyState();
  const [maximized, setMaximized] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const meta = useResizable({
    initial: 200,
    min: 48,
    getMax: () => (messageRef.current?.clientHeight ?? 400) - 140,
    storageKey: "germi.metaHeight",
    axis: "y",
  });

  const ct = contentType(msg.headers);
  const isRawEncoded = !decode && !!msg.encoding;
  const kind = bodyKind(msg, ct, decode);
  const encLabel = encodingLabel(msg, decode);

  const { pretty, canPretty } = useMemo(() => prettify(ct, msg.bodyText), [ct, msg.bodyText]);
  const text = view === "pretty" && canPretty ? pretty : msg.bodyText;

  const query = side === "request" ? parseQuery(path) : [];
  const cookies = parseCookies(msg.headers, side);

  const bodyRegion = (inMaximize: boolean) => (
    <>
      <BodyBar
        msg={msg}
        kind={kind}
        encLabel={encLabel}
        canPretty={canPretty}
        view={view}
        setView={setView}
        showHex={showHex}
        setShowHex={setShowHex}
        wrap={wrap}
        setWrap={setWrap}
        findOpen={findOpen}
        setFindOpen={setFindOpen}
        copy={copy}
        onMaximize={inMaximize ? undefined : () => setMaximized(true)}
      />

      {msg.truncated && (
        <div className="trunc-banner">
          Showing first 512&nbsp;KB of {fmtSize(msg.size)}.{" "}
          <button className="link" onClick={onLoadFull}>
            Load full body
          </button>
        </div>
      )}

      {msg.decodeTruncated && (
        <div className="trunc-banner">
          Decoded body truncated at 64&nbsp;MiB — too large to fully decode.
        </div>
      )}

      <MessageBody
        msg={msg}
        kind={kind}
        ct={ct}
        text={text}
        wrap={wrap}
        findOpen={findOpen}
        onCloseFind={() => setFindOpen(false)}
        isRawEncoded={isRawEncoded}
        showHex={showHex}
      />
    </>
  );

  return (
    <div className="message" ref={messageRef}>
      <MetaPanel
        msg={msg}
        side={side}
        query={query}
        cookies={cookies}
        copy={copy}
        style={{ height: meta.size, flex: "none", maxHeight: "none" }}
      />

      <div
        className="resizer-v"
        onPointerDown={meta.onPointerDown}
        title="Drag to resize headers / body"
      />

      {maximized ? (
        <MaximizedOverlay
          title={side === "request" ? "Request body" : "Response body"}
          onClose={() => setMaximized(false)}
        >
          {bodyRegion(true)}
        </MaximizedOverlay>
      ) : (
        bodyRegion(false)
      )}
    </div>
  );
}

function RequestHead({
  detail,
  ttfb,
  onMock,
  url,
  copy,
}: {
  detail: FlowDetail;
  ttfb: number | null;
  onMock: (detail: FlowDetail) => void;
  url: string;
  copy: (label: string, value: string) => void;
}) {
  return (
    <div className="req-head">
      <div className="req-line">
        <span className={`badge m-${detail.method.toLowerCase()}`}>{detail.method}</span>
        {detail.status !== null && <span className="badge status">{detail.status}</span>}
        {detail.matchedRule && <span className="badge rule">⚡ {detail.matchedRule}</span>}
        {ttfb !== null && <span className="muted timing">TTFB {ttfb} ms</span>}
        {detail.durationMs !== null && <span className="muted timing">{detail.durationMs} ms</span>}
        <button
          className="btn primary mock-btn"
          onClick={() => onMock(detail)}
          title="Create an autoresponder rule seeded from this response"
        >
          ⚡ Mock this →
        </button>
      </div>
      <div className="req-url">
        <span className="url-text">{url}</span>
        <div className="url-actions">
          <button className="btn ghost url-copy" title="Copy URL" onClick={() => copy("URL", url)}>
            ⧉ URL
          </button>
          <button
            className="btn ghost url-copy"
            title="Copy as cURL"
            onClick={() => copy("cURL command", toCurl(detail))}
          >
            cURL
          </button>
        </div>
      </div>
    </div>
  );
}

function statusCls(status: number | null): string {
  if (status === null) return "pending";
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 300) return "s3";
  return "s2";
}

const STATUS_ORDER: { cls: string; label: string }[] = [
  { cls: "s2", label: "2xx" },
  { cls: "s3", label: "3xx" },
  { cls: "s4", label: "4xx" },
  { cls: "s5", label: "5xx" },
  { cls: "pending", label: "pending" },
];

function summarize(flows: FlowSummary[]) {
  const hosts = new Set<string>();
  const byStatus = new Map<string, number>();
  let totalSize = 0;
  for (const f of flows) {
    hosts.add(f.host);
    totalSize += f.reqSize + f.respSize;
    const c = statusCls(f.status);
    byStatus.set(c, (byStatus.get(c) ?? 0) + 1);
  }
  return { hostCount: hosts.size, totalSize, byStatus };
}

function MultiSelectView({
  flows,
  onSelectOne,
  onMockMany,
  onClearSelection,
}: {
  flows: FlowSummary[];
  onSelectOne: (id: string) => void;
  onMockMany: (ids: string[]) => void;
  onClearSelection: () => void;
}) {
  const notify = useToast();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });
  const stats = useMemo(() => summarize(flows), [flows]);

  const copyUrls = () => {
    void navigator.clipboard.writeText(
      flows.map((f) => `${f.scheme}://${f.host}${f.path}`).join("\n"),
    );
    notify("success", `Copied ${flows.length} URLs`);
  };

  return (
    <div className="inspector multi">
      <div className="multi-head">
        <div className="multi-top">
          <span className="multi-title">
            <strong>{flows.length}</strong> requests selected
          </span>
          <div className="multi-actions">
            <button className="btn primary" onClick={() => onMockMany(flows.map((f) => f.id))}>
              ⚡ Mock all
            </button>
            <button className="btn ghost" onClick={copyUrls}>
              Copy URLs
            </button>
            <button className="btn ghost" onClick={onClearSelection}>
              Clear
            </button>
          </div>
        </div>
        <div className="multi-stats">
          <span className="muted">
            {stats.hostCount} {stats.hostCount === 1 ? "host" : "hosts"}
          </span>
          <span className="muted">·</span>
          <span className="muted">{fmtSize(stats.totalSize)}</span>
          {STATUS_ORDER.map(({ cls, label }) =>
            stats.byStatus.get(cls) ? (
              <span key={cls} className={`multi-tag ${cls}`}>
                {label} · {stats.byStatus.get(cls)}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div ref={parentRef} className="multi-list">
        <div className="multi-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const f = flows[item.index];
            return (
              <button
                key={f.id}
                type="button"
                className="multi-row"
                style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                onClick={() => onSelectOne(f.id)}
                title="Inspect this request"
              >
                <span className={`badge m-${f.method.toLowerCase()}`}>{f.method}</span>
                <span className={`multi-code ${statusCls(f.status)}`}>{f.status ?? "···"}</span>
                <span className="multi-host">{f.host}</span>
                <span className="multi-path">{f.path}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SingleFlowView({ detail, summary, loading, onMock, decode, onLoadFull }: SingleProps) {
  const copy = useCopy();
  const [side, setSide] = useState<Side>("response");

  if (!detail) {
    return (
      <div className="inspector empty-pane">
        <span className="muted">{loading ? "Loading…" : "Select a request to inspect."}</span>
      </div>
    );
  }

  const showResponse = side === "response" && detail.response;
  const url = `${detail.scheme}://${detail.host}${detail.path}`;
  const ttfb = summary?.ttfbMs ?? null;

  return (
    <div className="inspector">
      <RequestHead detail={detail} ttfb={ttfb} onMock={onMock} url={url} copy={copy} />

      <div className="seg sides">
        <button className={side === "request" ? "on" : ""} onClick={() => setSide("request")}>
          Request
        </button>
        <button
          className={side === "response" ? "on" : ""}
          onClick={() => setSide("response")}
          disabled={!detail.response}
        >
          Response {detail.response ? "" : "(pending)"}
        </button>
      </div>

      {showResponse && detail.response ? (
        <MessageView
          key={`${detail.id}-response`}
          msg={detail.response}
          side="response"
          path={detail.path}
          decode={decode}
          onLoadFull={onLoadFull}
        />
      ) : (
        <MessageView
          key={`${detail.id}-request`}
          msg={detail.request}
          side="request"
          path={detail.path}
          decode={decode}
          onLoadFull={onLoadFull}
        />
      )}
    </div>
  );
}

export function FlowInspector(props: Props) {
  if (props.selectedSummaries.length > 1) {
    return (
      <MultiSelectView
        flows={props.selectedSummaries}
        onSelectOne={props.onSelectOne}
        onMockMany={props.onMockMany}
        onClearSelection={props.onClearSelection}
      />
    );
  }
  return (
    <SingleFlowView
      detail={props.detail}
      summary={props.summary}
      loading={props.loading}
      onMock={props.onMock}
      decode={props.decode}
      onLoadFull={props.onLoadFull}
    />
  );
}
