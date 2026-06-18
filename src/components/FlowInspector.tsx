import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FlowDetail, MessageDetail } from "../types";

const ROW_H = 18;
const MAX_ROW = 2000;

/** Split body text into bounded-width rows (also chunking single giant lines,
 *  e.g. minified JSON/HTML) so they can be virtualized at a fixed row height. */
function toRows(text: string): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= MAX_ROW) {
      rows.push(line);
    } else {
      for (let i = 0; i < line.length; i += MAX_ROW) {
        rows.push(line.slice(i, i + MAX_ROW));
      }
    }
  }
  return rows.length ? rows : [""];
}

/** Virtualized text viewer — renders only visible lines, so multi-MB bodies
 *  scroll smoothly. No wrapping (fixed row height); long lines scroll across. */
function VirtualText({ text, hex }: { text: string; hex?: boolean }) {
  const rows = useMemo(() => toRows(text), [text]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 40,
  });
  return (
    <div ref={parentRef} className={`vtext ${hex ? "hex" : ""}`}>
      <div className="vtext-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.index}
            className="vline"
            style={{ transform: `translateY(${item.start}px)`, height: item.size }}
          >
            {rows[item.index] === "" ? " " : rows[item.index]}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  detail: FlowDetail | null;
  onMock: (detail: FlowDetail) => void;
  decode: boolean;
  onLoadFull: () => void;
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

/** Decide whether a body should be shown as text, an image, or binary/hex. */
function classify(ct: string, text: string): "image" | "text" | "binary" {
  // SVG is XML text — the backend treats it as textual (no base64), so render it
  // from bodyText rather than as an <img> with an empty data URL.
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
  // Unknown content-type — sniff by replacement-character ratio.
  const sample = text.slice(0, 2000);
  if (!sample) return "text";
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad / sample.length > 0.08 ? "binary" : "text";
}

/** Produce a "pretty" rendering for formats that have one. `canPretty` is false
 *  when pretty would be identical to raw (so the toggle can be hidden). */
function prettify(ct: string, text: string): { pretty: string; canPretty: boolean } {
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

/** Hex + ASCII dump of (a prefix of) a base64-encoded body. */
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

function bodyKind(
  msg: MessageDetail,
  ct: string,
  decode: boolean,
): "image" | "text" | "binary" {
  if (msg.size === 0) return "text";
  if (!decode && msg.encoding) return "binary";
  return classify(ct, msg.bodyText);
}

function encodingLabel(msg: MessageDetail, decode: boolean): string | null {
  if (!msg.encoding) return null;
  if (msg.decoded) return `${msg.encoding} · decoded`;
  return `${msg.encoding}${decode ? "" : " · raw"}`;
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

function MessageBody({
  msg,
  kind,
  ct,
  text,
  isRawEncoded,
  showHex,
}: {
  msg: MessageDetail;
  kind: "image" | "text" | "binary";
  ct: string;
  text: string;
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
  if (kind === "image" && msg.truncated) {
    return (
      <div className="binary-note">
        <span className="muted">
          Image · {fmtSize(msg.size)} — too large to preview. Load the full body
          to view it.
        </span>
      </div>
    );
  }
  if (kind === "image") {
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
  if (kind === "binary") {
    return (
      <div className="binary-note">
        <span className="muted">
          {isRawEncoded
            ? `Raw ${msg.encoding} body · ${fmtSize(msg.size)} — turn Decode on to read it.`
            : `Binary content${ct ? ` · ${ct}` : ""} · ${fmtSize(
                msg.size,
              )} — not shown as text.`}
        </span>
        {showHex && <VirtualText text={hexDump(msg.bodyBase64)} hex />}
      </div>
    );
  }
  return <VirtualText text={text} />;
}

function MessageView({
  msg,
  decode,
  onLoadFull,
}: {
  msg: MessageDetail;
  decode: boolean;
  onLoadFull: () => void;
}) {
  const [view, setView] = useState<BodyView>("pretty");
  const [showHex, setShowHex] = useState(false);

  const ct = contentType(msg.headers);
  const isRawEncoded = !decode && !!msg.encoding;
  const kind = bodyKind(msg, ct, decode);
  const encLabel = encodingLabel(msg, decode);

  const { pretty, canPretty } = prettify(ct, msg.bodyText);
  const text = view === "pretty" && canPretty ? pretty : msg.bodyText;

  return (
    <div className="message">
      <MessageHeaders headers={msg.headers} />

      <div className="body-bar">
        <span className="body-meta">
          <span className="muted">Body · {fmtSize(msg.size)}</span>
          {encLabel && <span className="enc-chip">{encLabel}</span>}
        </span>
        {kind === "text" && canPretty && (
          <div className="seg">
            <button
              className={view === "pretty" ? "on" : ""}
              onClick={() => setView("pretty")}
            >
              Pretty
            </button>
            <button
              className={view === "raw" ? "on" : ""}
              onClick={() => setView("raw")}
            >
              Raw
            </button>
          </div>
        )}
        {kind === "binary" && (
          <div className="seg">
            <button
              className={showHex ? "on" : ""}
              onClick={() => setShowHex((s) => !s)}
            >
              Hex
            </button>
          </div>
        )}
      </div>

      {msg.truncated && (
        <div className="trunc-banner">
          Showing first 512&nbsp;KB of {fmtSize(msg.size)}.{" "}
          <button className="link" onClick={onLoadFull}>
            Load full body
          </button>
        </div>
      )}

      <MessageBody
        msg={msg}
        kind={kind}
        ct={ct}
        text={text}
        isRawEncoded={isRawEncoded}
        showHex={showHex}
      />
    </div>
  );
}

export function FlowInspector({ detail, onMock, decode, onLoadFull }: Props) {
  const [side, setSide] = useState<Side>("response");

  if (!detail) {
    return (
      <div className="inspector empty-pane">
        <span className="muted">Select a request to inspect.</span>
      </div>
    );
  }

  const showResponse = side === "response" && detail.response;
  const url = `${detail.scheme}://${detail.host}${detail.path}`;

  return (
    <div className="inspector">
      <div className="req-head">
        <div className="req-line">
          <span className={`badge m-${detail.method.toLowerCase()}`}>
            {detail.method}
          </span>
          {detail.status !== null && (
            <span className="badge status">{detail.status}</span>
          )}
          {detail.matchedRule && (
            <span className="badge rule">⚡ {detail.matchedRule}</span>
          )}
          {detail.durationMs !== null && (
            <span className="muted">{detail.durationMs} ms</span>
          )}
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
          <button
            className="btn ghost url-copy"
            title="Copy URL"
            onClick={() => void navigator.clipboard.writeText(url)}
          >
            ⧉
          </button>
        </div>
      </div>

      <div className="seg sides">
        <button
          className={side === "request" ? "on" : ""}
          onClick={() => setSide("request")}
        >
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

      {/* key on flow id + side so switching selection or side remounts with fresh
          Pretty/Raw/Hex toggle state and scroll position (no stale carry-over). */}
      {showResponse && detail.response ? (
        <MessageView
          key={`${detail.id}-response`}
          msg={detail.response}
          decode={decode}
          onLoadFull={onLoadFull}
        />
      ) : (
        <MessageView
          key={`${detail.id}-request`}
          msg={detail.request}
          decode={decode}
          onLoadFull={onLoadFull}
        />
      )}
    </div>
  );
}
