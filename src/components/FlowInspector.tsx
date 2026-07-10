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
import { countBy, sumBy } from "es-toolkit";

import type { Availability, FlowDetail, FlowSummary, MessageDetail } from "../types";
import { availabilityLabel } from "../availability";
import { statusCls } from "../filter";
import { useToast } from "../toast";
import { copyText, useCopy } from "../useCopy";
import { useResizable } from "../useResizable";
import { headersToText, parseCookies, parseQuery, toCurl, type KV } from "../curl";
import { rawMessage, requestLine, statusLine } from "../rawHttp";
import { MaximizedOverlay } from "./MaximizedOverlay";
import {
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconCompare,
  IconCopy,
  IconExternal,
  IconMaximize,
  IconMock,
} from "./icons";
import { Button } from "./ui/Button";
import { SegmentedControl } from "./ui/SegmentedControl";
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
  let lc = fold(line, caseSensitive);
  let q = fold(query, caseSensitive);
  // Folding (toLowerCase) can change string length for a few code points (İ, ẞ,
  // ligatures). When it does, folded indices no longer line up with the original
  // string and the <mark> would cover the wrong characters — fall back to an exact
  // match so the highlighted span is always correct (case just isn't folded on
  // that rare line). Match counting (inspectorFind.ts) folds consistently, so the
  // count stays right regardless.
  if (lc.length !== line.length || q.length !== query.length) {
    lc = line;
    q = query;
  }
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
    if (activeLine < 0) return;
    // Step 1: scroll the row into the virtual window so its DOM exists.
    virtualizer.scrollToIndex(activeLine, { align: "center" });
    // Step 2: row-centering only handles vertical placement of the whole row,
    // which misses the exact hit on a wrapped row taller than the viewport and
    // never scrolls horizontally for a long unwrapped line. Once the row has
    // rendered, bring the active occurrence itself into view in both axes.
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollElement
        ?.querySelector(".vmatch.active")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
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
    <SegmentedControl
      className="find-scope"
      options={SCOPES.map((sc) => ({ value: sc.id, label: sc.label }))}
      value={scope}
      onChange={setScope}
    />
  );
}

function FindBar({ find, rawMode }: { find: InspectorFind; rawMode: boolean }) {
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
      {!rawMode && <ScopeChips scope={find.scope} setScope={find.setScope} />}
      <Button
        variant={find.caseSensitive ? "default" : "ghost"}
        className={find.caseSensitive ? "find-case on" : "find-case"}
        title="Match case"
        aria-pressed={find.caseSensitive}
        onClick={find.toggleCase}
      >
        Aa
      </Button>
      <span className="vfind-count">
        {query ? (total ? `${Math.min(activeIndex + 1, total)}/${total}` : "0/0") : ""}
      </span>
      <Button
        variant="ghost"
        title="Previous (Shift+Enter)"
        onClick={() => find.step(-1)}
        disabled={!total}
      >
        <IconArrowUp />
      </Button>
      <Button variant="ghost" title="Next (Enter)" onClick={() => find.step(1)} disabled={!total}>
        <IconArrowDown />
      </Button>
      <Button variant="ghost" title="Close (Esc)" onClick={find.close}>
        <IconClose />
      </Button>
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
      ref={measureElement}
      className={`vline ${isHit ? "hit" : ""} ${isActive ? "active" : ""}`}
      style={style}
    >
      {highlight(line, query, isActive ? activeOcc : -1, caseSensitive)}
    </div>
  );
}

const NO_COUNT = () => {};

/** Virtualized text viewer driven by the lifted inspector find (when present). */
export function VirtualText({
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

  const prevWrap = useRef(wrap);
  useEffect(() => {
    if (prevWrap.current !== wrap) {
      prevWrap.current = wrap;
      virtualizer.measure();
    }
  }, [wrap, virtualizer]);

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
  /** Viewer mode disables the autoresponder, so the mock buttons are hidden. */
  viewer: boolean;
  decode: boolean;
  onLoadFull: () => void;
  inspectorFindRef: React.RefObject<InspectorFindHandle | null>;
}

interface Props extends SingleProps {
  selectedSummaries: FlowSummary[];
  onSelectOne: (id: string) => void;
  onMockMany: (ids: string[]) => void;
  onCompare: () => void;
  onClearSelection: () => void;
}

type BodyView = "pretty" | "raw";
type MsgView = "parsed" | "raw";

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
          <Button
            variant="ghost"
            size="small"
            className="kv-copy"
            title="Copy headers"
            onClick={() => copy("Headers", headersToText(msg.headers))}
          >
            <IconCopy />
          </Button>
        </div>
        <MessageHeaders headers={msg.headers} find={find} />
      </div>
    </div>
  );
}

function PrettyRawToggle({ view, setView }: { view: BodyView; setView: (v: BodyView) => void }) {
  return (
    <SegmentedControl
      options={[
        { value: "pretty", label: "Pretty" },
        { value: "raw", label: "Raw" },
      ]}
      value={view}
      onChange={setView}
    />
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
}: {
  wrap: boolean;
  setWrap: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <Button
      variant={wrap ? "default" : "ghost"}
      active={wrap}
      size="small"
      title="Toggle word wrap"
      onClick={() => setWrap((w) => !w)}
    >
      Wrap
    </Button>
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
        {kind === "text" && <TextActions wrap={wrap} setWrap={setWrap} />}
        <Button
          variant="ghost"
          size="small"
          title="Copy body"
          onClick={() => copy("Body", msg.bodyText)}
        >
          Copy body
        </Button>
        {onMaximize && (
          <Button variant="ghost" size="small" title="Maximize (full view)" onClick={onMaximize}>
            <IconMaximize />
          </Button>
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

function RawView({
  side,
  startLine,
  msg,
  find,
  onLoadFull,
}: {
  side: Side;
  startLine: string;
  msg: MessageDetail;
  find: InspectorFind;
  onLoadFull: () => void;
}) {
  const copy = useCopy();
  const [wrap, setWrap] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const rawText = useMemo(
    () => rawMessage(startLine, msg.headers, msg.bodyText),
    [startLine, msg.headers, msg.bodyText],
  );

  const region = (inMaximize: boolean) => (
    <>
      <div className="body-bar">
        <span className="body-meta">
          <span className="muted">Raw {side}</span>
        </span>
        <div className="body-actions">
          <TextActions wrap={wrap} setWrap={setWrap} />
          <Button
            variant="ghost"
            size="small"
            title="Copy raw message"
            onClick={() => copy(side === "request" ? "Raw request" : "Raw response", rawText)}
          >
            Copy
          </Button>
          {!inMaximize && (
            <Button
              variant="ghost"
              size="small"
              title="Maximize (full view)"
              onClick={() => setMaximized(true)}
            >
              <IconMaximize />
            </Button>
          )}
        </div>
      </div>

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

      <VirtualText text={rawText} wrap={wrap} find={find} />
    </>
  );

  return (
    <div className="message">
      {maximized ? (
        <MaximizedOverlay
          title={side === "request" ? "Raw request" : "Raw response"}
          onClose={() => setMaximized(false)}
        >
          {region(true)}
        </MaximizedOverlay>
      ) : (
        region(false)
      )}
    </div>
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
  viewer,
  url,
  find,
  copy,
}: {
  detail: FlowDetail;
  ttfb: number | null;
  onMock: (detail: FlowDetail) => void;
  viewer: boolean;
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
        {detail.matchedRule && (
          <span className="badge rule">
            <IconMock /> {detail.matchedRule}
          </span>
        )}
        {ttfb !== null && <span className="muted timing">TTFB {ttfb} ms</span>}
        {detail.durationMs !== null && <span className="muted timing">{detail.durationMs} ms</span>}
        {!viewer && (
          <Button
            variant="primary"
            className="mock-btn"
            onClick={() => onMock(detail)}
            title="Create an autoresponder rule seeded from this response"
          >
            <IconMock /> Mock this →
          </Button>
        )}
      </div>
      <div className="req-url">
        <span className="url-text">
          {urlQuery ? highlight(url, urlQuery, find.urlActive, caseSensitive) : url}
        </span>
        <div className="url-actions">
          <Button
            variant="ghost"
            className="url-copy"
            title="Copy URL"
            onClick={() => copy("URL", url)}
          >
            <IconCopy /> URL
          </Button>
          <Button
            variant="ghost"
            className="url-copy"
            title="Copy as cURL"
            onClick={() => copy("cURL command", toCurl(detail))}
          >
            cURL
          </Button>
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
      <Button
        variant="ghost"
        size="small"
        className="avail-open"
        title="Open this URL in your default browser (without the captured session's cookies)"
        onClick={() => void openUrl(url)}
      >
        <IconExternal /> Open in browser
      </Button>
    </div>
  );
}

const STATUS_ORDER: { cls: string; label: string }[] = [
  { cls: "s2", label: "2xx" },
  { cls: "s3", label: "3xx" },
  { cls: "s4", label: "4xx" },
  { cls: "s5", label: "5xx" },
  { cls: "pending", label: "pending" },
];

function summarize(flows: FlowSummary[]) {
  const hosts = new Set(flows.map((f) => f.host));
  const byStatus = countBy(flows, (f) => statusCls(f.status));
  const totalSize = sumBy(flows, (f) => f.reqSize + f.respSize);
  return { hostCount: hosts.size, totalSize, byStatus };
}

function MultiSelectView({
  flows,
  onSelectOne,
  onMockMany,
  onCompare,
  onClearSelection,
  viewer,
}: {
  flows: FlowSummary[];
  onSelectOne: (id: string) => void;
  onMockMany: (ids: string[]) => void;
  onCompare: () => void;
  onClearSelection: () => void;
  viewer: boolean;
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
    const urls = flows.map((f) => `${f.scheme}://${f.host}${f.path}`).join("\n");
    void copyText(notify, `${flows.length} URLs`, urls);
  };

  return (
    <div className="inspector multi">
      <div className="multi-head">
        <div className="multi-top">
          <span className="multi-title">
            <strong>{flows.length}</strong> requests selected
          </span>
          <div className="multi-actions">
            {!viewer && (
              <Button variant="primary" onClick={() => onMockMany(flows.map((f) => f.id))}>
                <IconMock /> Mock all
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={onCompare}
              title={
                flows.length === 2
                  ? "Diff these two requests"
                  : "Open the compare view with this selection"
              }
            >
              <IconCompare /> Compare
            </Button>
            <Button variant="ghost" onClick={copyUrls}>
              Copy URLs
            </Button>
            <Button variant="ghost" onClick={onClearSelection}>
              Clear
            </Button>
          </div>
        </div>
        <div className="multi-stats">
          <span className="muted">
            {stats.hostCount} {stats.hostCount === 1 ? "host" : "hosts"}
          </span>
          <span className="muted">·</span>
          <span className="muted">{fmtSize(stats.totalSize)}</span>
          {STATUS_ORDER.map(({ cls, label }) =>
            stats.byStatus[cls] ? (
              <span key={cls} className={`multi-tag ${cls}`}>
                {label} · {stats.byStatus[cls]}
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
  rawMode: boolean,
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

  const effScope: FindScope = rawMode ? "body" : scope;
  const query = rest.open ? rawQuery : "";
  const headerPairs = useMemo(
    () => (rawMode ? [] : (activeMsg?.headers ?? [])),
    [rawMode, activeMsg],
  );
  const effUrl = rawMode ? "" : url;
  const combined = useMemo(
    () => combineMatches(effUrl, headerPairs, bodyCount, query, effScope, caseSensitive),
    [effUrl, headerPairs, bodyCount, query, effScope, caseSensitive],
  );

  const { total, regionForIndex } = combined;
  // Reset the body match count on every flow/side/mode change. A text body viewer
  // reports its real count on mount; an image/binary/empty body mounts no viewer,
  // so without this reset the previous flow's body count would leak into the total.
  useEffect(() => {
    setActiveIndex(0);
    setBodyCount(0);
  }, [detail?.id, side, rawMode, setActiveIndex]);

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
    scope: effScope,
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
    <SegmentedControl
      options={[
        { value: "request", label: "Request" },
        {
          value: "response",
          label: <>Response {hasResponse ? "" : "(pending)"}</>,
          disabled: !hasResponse,
        },
      ]}
      value={side}
      onChange={setSide}
    />
  );
}

function resolveActive(detail: FlowDetail | null, side: Side) {
  const showResponse = !!detail?.response && side === "response";
  const activeSide: Side = showResponse ? "response" : "request";
  const activeMsg = detail ? (showResponse ? detail.response : detail.request) : null;
  const url = detail ? `${detail.scheme}://${detail.host}${detail.path}` : "";
  return { activeSide, activeMsg, url };
}

function ViewToggle({
  msgView,
  setMsgView,
}: {
  msgView: MsgView;
  setMsgView: (v: MsgView) => void;
}) {
  return (
    <SegmentedControl
      options={[
        { value: "parsed", label: "Parsed" },
        { value: "raw", label: "Raw" },
      ]}
      value={msgView}
      onChange={setMsgView}
    />
  );
}

function FlowMessage({
  detail,
  activeMsg,
  activeSide,
  msgView,
  decode,
  find,
  onLoadFull,
}: {
  detail: FlowDetail;
  activeMsg: MessageDetail;
  activeSide: Side;
  msgView: MsgView;
  decode: boolean;
  find: InspectorFind;
  onLoadFull: () => void;
}) {
  if (msgView === "raw") {
    const startLine = activeSide === "request" ? requestLine(detail) : statusLine(detail);
    return (
      <RawView
        key={`${detail.id}-${activeSide}-raw`}
        side={activeSide}
        startLine={startLine}
        msg={activeMsg}
        find={find}
        onLoadFull={onLoadFull}
      />
    );
  }
  return (
    <MessageView
      key={`${detail.id}-${activeSide}`}
      msg={activeMsg}
      side={activeSide}
      path={detail.path}
      decode={decode}
      find={find}
      onLoadFull={onLoadFull}
    />
  );
}

function InspectorEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="inspector empty-pane">
      <span className="muted">{loading ? "Loading…" : "Select a request to inspect."}</span>
    </div>
  );
}

function SingleFlowView({
  detail,
  summary,
  loading,
  onMock,
  viewer,
  decode,
  onLoadFull,
  inspectorFindRef,
}: SingleProps) {
  const copy = useCopy();
  const [side, setSide] = useState<Side>("response");
  const [msgView, setMsgView] = useState<MsgView>("parsed");
  const rawMode = msgView === "raw";

  const { activeSide, activeMsg, url } = resolveActive(detail, side);
  const find = useFindCoordinator(detail, activeSide, activeMsg, url, rawMode);
  useRegisterFind(detail, inspectorFindRef, find);

  if (!detail || !activeMsg) {
    return <InspectorEmpty loading={loading} />;
  }

  return (
    <div className="inspector">
      {find.open && <FindBar find={find} rawMode={rawMode} />}
      <RequestHead
        detail={detail}
        ttfb={summary?.ttfbMs ?? null}
        onMock={onMock}
        viewer={viewer}
        url={url}
        find={find}
        copy={copy}
      />
      {summary?.availability && <AvailabilityPanel availability={summary.availability} url={url} />}
      <div className="inspect-modes">
        <SideToggle side={activeSide} setSide={setSide} hasResponse={!!detail.response} />
        <ViewToggle msgView={msgView} setMsgView={setMsgView} />
      </div>
      <FlowMessage
        detail={detail}
        activeMsg={activeMsg}
        activeSide={activeSide}
        msgView={msgView}
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
        onCompare={props.onCompare}
        onClearSelection={props.onClearSelection}
        viewer={props.viewer}
      />
    );
  }
  return (
    <SingleFlowView
      detail={props.detail}
      summary={props.summary}
      loading={props.loading}
      onMock={props.onMock}
      viewer={props.viewer}
      decode={props.decode}
      onLoadFull={props.onLoadFull}
      inspectorFindRef={props.inspectorFindRef}
    />
  );
}
