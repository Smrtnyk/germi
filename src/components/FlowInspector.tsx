import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { openUrl } from "@tauri-apps/plugin-opener";

import type { Availability, FlowDetail, FlowSummary, MessageDetail } from "../types";
import { availabilityLabel } from "../availability";
import { useToast } from "../toast";
import { useCopy } from "../useCopy";
import { useResizable } from "../useResizable";
import { headersToText, parseCookies, parseQuery, toCurl, type KV } from "../curl";
import { MaximizedOverlay } from "./MaximizedOverlay";
import {
  bodyOccurrences,
  combineMatches,
  fold,
  type FindScope,
  type InspectorFindHandle,
  type RegionLocation,
} from "../inspectorFind";

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

function highlight(
  line: string,
  query: string,
  activeOccurrence = -1,
  caseSensitive = false,
): ReactNode {
  if (!query) return line === "" ? " " : line;
  const lc = fold(line, caseSensitive);
  const q = fold(query, caseSensitive);
  const nodes: ReactNode[] = [];
  let from = 0;
  let key = 0;
  let occ = 0;
  let i = lc.indexOf(q, from);
  if (i === -1) return line;
  while (i !== -1) {
    if (i > from) nodes.push(line.slice(from, i));
    nodes.push(
      <mark key={key++} className={occ === activeOccurrence ? "vmatch active" : "vmatch"}>
        {line.slice(i, i + query.length)}
      </mark>,
    );
    occ++;
    from = i + query.length;
    i = lc.indexOf(q, from);
  }
  if (from < line.length) nodes.push(line.slice(from));
  return nodes;
}

type Side = "request" | "response";

interface InspectorFind {
  open: boolean;
  query: string;
  scope: FindScope;
  caseSensitive: boolean;
  setQuery: (q: string) => void;
  setScope: (s: FindScope) => void;
  toggleCase: () => void;
  openFind: (seed?: string, scope?: FindScope) => void;
  close: () => void;
  step: (dir: number) => void;
  findRef: React.RefObject<HTMLInputElement | null>;
  total: number;
  activeIndex: number;
  side: Side;
  urlActive: number;
  headerActiveRow: number;
  headerActiveField: number;
  headerActiveOcc: number;
  bodyActive: number;
  onBodyMatchCount: (n: number) => void;
}

function useInspectorFind() {
  const findRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScopeState] = useState<FindScope>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const openFind = useCallback((seed?: string, nextScope?: FindScope) => {
    setOpen(true);
    setActiveIndex(0);
    if (seed !== undefined) setQuery(seed);
    if (nextScope !== undefined) setScopeState(nextScope);
    requestAnimationFrame(() => findRef.current?.focus());
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const setScope = useCallback((s: FindScope) => {
    setScopeState(s);
    setActiveIndex(0);
  }, []);
  const toggleCase = useCallback(() => {
    setCaseSensitive((c) => !c);
    setActiveIndex(0);
  }, []);

  return {
    findRef,
    open,
    query,
    scope,
    caseSensitive,
    activeIndex,
    setQuery,
    setScope,
    toggleCase,
    setActiveIndex,
    openFind,
    close,
  };
}

type Virtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;

function useFind(
  rows: string[],
  query: string,
  caseSensitive: boolean,
  bodyActive: boolean,
  bodyIndex: number,
  onMatchCount: (n: number) => void,
  virtualizer: Virtualizer,
) {
  const matches = useMemo(
    () => bodyOccurrences(rows, query, caseSensitive),
    [rows, query, caseSensitive],
  );

  useEffect(() => onMatchCount(matches.length), [matches, onMatchCount]);

  const active =
    bodyActive && matches.length ? matches[Math.min(bodyIndex, matches.length - 1)] : null;
  const activeLine = active ? active.line : -1;
  const activeOcc = active ? active.occ : -1;

  useEffect(() => {
    if (activeLine >= 0) virtualizer.scrollToIndex(activeLine, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLine, activeOcc, matches]);

  return { activeLine, activeOcc };
}

const SCOPES: { id: FindScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "url", label: "URL" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
];

function ScopeChips({ scope, setScope }: { scope: FindScope; setScope: (s: FindScope) => void }) {
  return (
    <div className="seg find-scope">
      {SCOPES.map((sc) => (
        <button key={sc.id} className={scope === sc.id ? "on" : ""} onClick={() => setScope(sc.id)}>
          {sc.label}
        </button>
      ))}
    </div>
  );
}

function FindBar({ find }: { find: InspectorFind }) {
  const { query, total, activeIndex } = find;
  return (
    <div className="vfind">
      <input
        ref={find.findRef}
        value={query}
        placeholder={find.side === "request" ? "Find in request" : "Find in response"}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") find.step(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") find.close();
        }}
      />
      <ScopeChips scope={find.scope} setScope={find.setScope} />
      <button
        className={find.caseSensitive ? "btn find-case on" : "btn ghost find-case"}
        title="Match case"
        aria-pressed={find.caseSensitive}
        onClick={find.toggleCase}
      >
        Aa
      </button>
      <span className="vfind-count">
        {query ? (total ? `${Math.min(activeIndex + 1, total)}/${total}` : "0/0") : ""}
      </span>
      <button
        className="btn ghost"
        title="Previous (Shift+Enter)"
        onClick={() => find.step(-1)}
        disabled={!total}
      >
        ↑
      </button>
      <button
        className="btn ghost"
        title="Next (Enter)"
        onClick={() => find.step(1)}
        disabled={!total}
      >
        ↓
      </button>
      <button className="btn ghost" title="Close (Esc)" onClick={find.close}>
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
  caseSensitive,
  wrap,
  activeLine,
  activeOcc,
  measureElement,
}: {
  line: string;
  index: number;
  start: number;
  size: number;
  query: string;
  caseSensitive: boolean;
  wrap: boolean | undefined;
  activeLine: number;
  activeOcc: number;
  measureElement: Virtualizer["measureElement"];
}) {
  const isHit = query.length > 0 && fold(line, caseSensitive).includes(fold(query, caseSensitive));
  const isActive = index === activeLine;
  const style: CSSProperties = wrap
    ? { transform: `translateY(${start}px)` }
    : { transform: `translateY(${start}px)`, height: size };
  return (
    <div
      data-index={index}
      ref={wrap ? measureElement : undefined}
      className={`vline ${isHit ? "hit" : ""} ${isActive ? "active" : ""}`}
      style={style}
    >
      {highlight(line, query, isActive ? activeOcc : -1, caseSensitive)}
    </div>
  );
}

const NO_COUNT = () => {};

/** Virtualized text viewer driven by the lifted inspector find (when present). */
function VirtualText({
  text,
  hex,
  wrap,
  find,
}: {
  text: string;
  hex?: boolean;
  wrap?: boolean;
  find?: InspectorFind;
}) {
  const rows = useMemo(() => toRows(text), [text]);
  const parentRef = useRef<HTMLDivElement>(null);
  const query = find && (find.scope === "all" || find.scope === "body") ? find.query : "";
  const caseSensitive = !!find && find.caseSensitive;
  const bodyActive = !!find && find.bodyActive >= 0;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 40,
  });

  const { activeLine, activeOcc } = useFind(
    rows,
    query,
    caseSensitive,
    bodyActive,
    find ? find.bodyActive : 0,
    find?.onBodyMatchCount ?? NO_COUNT,
    virtualizer,
  );

  return (
    <div className={`vtext ${hex ? "hex" : ""} ${wrap ? "wrap" : ""}`}>
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
              caseSensitive={caseSensitive}
              wrap={wrap}
              activeLine={activeLine}
              activeOcc={activeOcc}
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
  inspectorFindRef: React.RefObject<InspectorFindHandle | null>;
}

interface Props extends SingleProps {
  selectedSummaries: FlowSummary[];
  onSelectOne: (id: string) => void;
  onMockMany: (ids: string[]) => void;
  onClearSelection: () => void;
}

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

function MessageHeaders({ headers, find }: { headers: [string, string][]; find: InspectorFind }) {
  const activeRef = useRef<HTMLDivElement>(null);
  const { headerActiveRow, headerActiveField, headerActiveOcc, caseSensitive } = find;
  const query = find.scope === "all" || find.scope === "headers" ? find.query : "";
  useEffect(() => {
    if (find.open && headerActiveRow >= 0) activeRef.current?.scrollIntoView({ block: "center" });
  }, [find.open, headerActiveRow, query]);

  return (
    <div className="headers">
      {headers.map(([k, v], i) => {
        const active = i === headerActiveRow;
        const kOcc = active && headerActiveField === 0 ? headerActiveOcc : -1;
        const vOcc = active && headerActiveField === 1 ? headerActiveOcc : -1;
        return (
          <div
            className={`hrow ${active ? "active" : ""}`}
            key={`${k}-${i}`}
            ref={active ? activeRef : undefined}
          >
            <span className="hkey">{query ? highlight(k, query, kOcc, caseSensitive) : k}</span>
            <span className="hval">{query ? highlight(v, query, vOcc, caseSensitive) : v}</span>
          </div>
        );
      })}
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
  find,
  isRawEncoded,
  showHex,
}: {
  msg: MessageDetail;
  kind: "image" | "text" | "binary";
  ct: string;
  text: string;
  wrap: boolean;
  find: InspectorFind;
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
  return <VirtualText text={text} wrap={wrap} find={find} />;
}

function useBodyState() {
  const [view, setView] = useState<BodyView>("pretty");
  const [showHex, setShowHex] = useState(false);
  const [wrap, setWrap] = useState(false);
  return { view, setView, showHex, setShowHex, wrap, setWrap };
}

function MetaPanel({
  msg,
  side,
  query,
  cookies,
  find,
  copy,
  style,
}: {
  msg: MessageDetail;
  side: Side;
  query: KV[];
  cookies: KV[];
  find: InspectorFind;
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
        <MessageHeaders headers={msg.headers} find={find} />
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
  find,
}: {
  wrap: boolean;
  setWrap: React.Dispatch<React.SetStateAction<boolean>>;
  find: InspectorFind;
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
        className={find.open ? "btn active small" : "btn ghost small"}
        title="Find (Ctrl/⌘ F)"
        onClick={() => (find.open ? find.close() : find.openFind(undefined, "body"))}
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
  find,
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
  find: InspectorFind;
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
        {kind === "text" && <TextActions wrap={wrap} setWrap={setWrap} find={find} />}
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

function useBodyContent(
  msg: MessageDetail,
  side: Side,
  path: string,
  decode: boolean,
  view: BodyView,
) {
  const ct = contentType(msg.headers);
  const { pretty, canPretty } = useMemo(() => prettify(ct, msg.bodyText), [ct, msg.bodyText]);
  return {
    ct,
    kind: bodyKind(msg, ct, decode),
    encLabel: encodingLabel(msg, decode),
    isRawEncoded: !decode && !!msg.encoding,
    canPretty,
    text: view === "pretty" && canPretty ? pretty : msg.bodyText,
    queryKv: side === "request" ? parseQuery(path) : [],
    cookies: parseCookies(msg.headers, side),
  };
}

function BodyRegion({
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
  find,
  copy,
  text,
  ct,
  isRawEncoded,
  onLoadFull,
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
  find: InspectorFind;
  copy: (label: string, value: string) => void;
  text: string;
  ct: string;
  isRawEncoded: boolean;
  onLoadFull: () => void;
  onMaximize?: () => void;
}) {
  return (
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
        find={find}
        copy={copy}
        onMaximize={onMaximize}
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
        find={find}
        isRawEncoded={isRawEncoded}
        showHex={showHex}
      />
    </>
  );
}

function MessageView({
  msg,
  side,
  path,
  decode,
  find,
  onLoadFull,
}: {
  msg: MessageDetail;
  side: Side;
  path: string;
  decode: boolean;
  find: InspectorFind;
  onLoadFull: () => void;
}) {
  const copy = useCopy();
  const { view, setView, showHex, setShowHex, wrap, setWrap } = useBodyState();
  const [maximized, setMaximized] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const meta = useResizable({
    initial: 200,
    min: 48,
    getMax: () => (messageRef.current?.clientHeight ?? 400) - 140,
    storageKey: "germi.metaHeight",
    axis: "y",
  });

  const { ct, kind, encLabel, isRawEncoded, canPretty, text, queryKv, cookies } = useBodyContent(
    msg,
    side,
    path,
    decode,
    view,
  );

  const bodyProps = {
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
    find,
    copy,
    text,
    ct,
    isRawEncoded,
    onLoadFull,
  };

  return (
    <div className="message" ref={messageRef}>
      <MetaPanel
        msg={msg}
        side={side}
        query={queryKv}
        cookies={cookies}
        find={find}
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
          <BodyRegion {...bodyProps} />
        </MaximizedOverlay>
      ) : (
        <BodyRegion {...bodyProps} onMaximize={() => setMaximized(true)} />
      )}
    </div>
  );
}

function RequestHead({
  detail,
  ttfb,
  onMock,
  url,
  find,
  copy,
}: {
  detail: FlowDetail;
  ttfb: number | null;
  onMock: (detail: FlowDetail) => void;
  url: string;
  find: InspectorFind;
  copy: (label: string, value: string) => void;
}) {
  const urlQuery = find.scope === "all" || find.scope === "url" ? find.query : "";
  const caseSensitive = find.caseSensitive;
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
        <span className="url-text">
          {urlQuery ? highlight(url, urlQuery, find.urlActive, caseSensitive) : url}
        </span>
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

/** Public-availability result for the selected doc flow: the worded verdict, the
 *  evidence (re-checked status + redirect target), and a one-click jump into the
 *  live URL (no captured credentials) — so a reachable app can be worked in live
 *  instead of replaying the session. */
function AvailabilityPanel({ availability, url }: { availability: Availability; url: string }) {
  const { text, tone, title } = availabilityLabel(availability);
  return (
    <div className="avail-panel">
      <span className="avail-panel-label">Public availability</span>
      <span className={`avail-badge avail-${tone}`} title={title}>
        {text}
      </span>
      {availability.status !== null && (
        <span className="muted">re-check {availability.status}</span>
      )}
      {availability.location && <span className="muted avail-loc">→ {availability.location}</span>}
      <button
        className="btn ghost small avail-open"
        title="Open this URL in your default browser (without the captured session's cookies)"
        onClick={() => void openUrl(url)}
      >
        ↗ Open in browser
      </button>
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

function activeFields(loc: RegionLocation | null) {
  return {
    urlActive: loc?.region === "url" ? loc.localIndex : -1,
    headerActiveRow: loc?.region === "header" ? loc.localIndex : -1,
    headerActiveField: loc?.region === "header" ? (loc.field ?? -1) : -1,
    headerActiveOcc: loc?.region === "header" ? (loc.occ ?? -1) : -1,
    bodyActive: loc?.region === "body" ? loc.localIndex : -1,
  };
}

function useFindCoordinator(
  detail: FlowDetail | null,
  side: Side,
  activeMsg: MessageDetail | null,
  url: string,
): InspectorFind {
  const {
    query: rawQuery,
    scope,
    caseSensitive,
    activeIndex: rawIndex,
    setActiveIndex,
    ...rest
  } = useInspectorFind();
  const [bodyCount, setBodyCount] = useState(0);
  const onBodyMatchCount = useCallback((n: number) => setBodyCount(n), []);

  const query = rest.open ? rawQuery : "";
  const headerPairs = useMemo(() => activeMsg?.headers ?? [], [activeMsg]);
  const combined = useMemo(
    () => combineMatches(url, headerPairs, bodyCount, query, scope, caseSensitive),
    [url, headerPairs, bodyCount, query, scope, caseSensitive],
  );

  const { total, regionForIndex } = combined;
  useEffect(() => setActiveIndex(0), [detail?.id, side, setActiveIndex]);

  const activeIndex = total ? Math.min(rawIndex, total - 1) : 0;
  const loc = regionForIndex(activeIndex);
  const step = useCallback(
    (dir: number) => {
      if (!total) return;
      setActiveIndex((i) => (Math.min(i, total - 1) + dir + total) % total);
    },
    [setActiveIndex, total],
  );

  return {
    query,
    scope,
    caseSensitive,
    open: rest.open,
    setQuery: rest.setQuery,
    setScope: rest.setScope,
    toggleCase: rest.toggleCase,
    openFind: rest.openFind,
    close: rest.close,
    findRef: rest.findRef,
    step,
    total,
    activeIndex,
    side,
    ...activeFields(loc),
    onBodyMatchCount,
  };
}

function useRegisterFind(
  detail: FlowDetail | null,
  ref: React.RefObject<InspectorFindHandle | null>,
  find: InspectorFind,
) {
  const { openFind, step, open } = find;
  useEffect(() => {
    if (!detail) return;
    ref.current = { openFind, step, open };
    return () => {
      ref.current = null;
    };
  }, [detail, openFind, step, open, ref]);
}

function SideToggle({
  side,
  setSide,
  hasResponse,
}: {
  side: Side;
  setSide: (s: Side) => void;
  hasResponse: boolean;
}) {
  return (
    <div className="seg sides">
      <button className={side === "request" ? "on" : ""} onClick={() => setSide("request")}>
        Request
      </button>
      <button
        className={side === "response" ? "on" : ""}
        onClick={() => setSide("response")}
        disabled={!hasResponse}
      >
        Response {hasResponse ? "" : "(pending)"}
      </button>
    </div>
  );
}

function resolveActive(detail: FlowDetail | null, side: Side) {
  const showResponse = !!detail?.response && side === "response";
  const activeSide: Side = showResponse ? "response" : "request";
  const activeMsg = detail ? (showResponse ? detail.response : detail.request) : null;
  const url = detail ? `${detail.scheme}://${detail.host}${detail.path}` : "";
  return { activeSide, activeMsg, url };
}

function SingleFlowView({
  detail,
  summary,
  loading,
  onMock,
  decode,
  onLoadFull,
  inspectorFindRef,
}: SingleProps) {
  const copy = useCopy();
  const [side, setSide] = useState<Side>("response");

  const { activeSide, activeMsg, url } = resolveActive(detail, side);
  const find = useFindCoordinator(detail, activeSide, activeMsg, url);
  useRegisterFind(detail, inspectorFindRef, find);

  if (!detail || !activeMsg) {
    return (
      <div className="inspector empty-pane">
        <span className="muted">{loading ? "Loading…" : "Select a request to inspect."}</span>
      </div>
    );
  }

  return (
    <div className="inspector">
      {find.open && <FindBar find={find} />}
      <RequestHead
        detail={detail}
        ttfb={summary?.ttfbMs ?? null}
        onMock={onMock}
        url={url}
        find={find}
        copy={copy}
      />
      {summary?.availability && <AvailabilityPanel availability={summary.availability} url={url} />}
      <SideToggle side={side} setSide={setSide} hasResponse={!!detail.response} />
      <MessageView
        key={`${detail.id}-${activeSide}`}
        msg={activeMsg}
        side={activeSide}
        path={detail.path}
        decode={decode}
        find={find}
        onLoadFull={onLoadFull}
      />
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
      inspectorFindRef={props.inspectorFindRef}
    />
  );
}
