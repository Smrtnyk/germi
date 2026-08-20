import type { FlowSummary, ResourceKind } from "./types";

/** Ordered, user-facing metadata shared by icon tooltips and the help legend.
 *  `ResourceType` is derived from this registry so a new family cannot acquire
 *  a glyph without also acquiring a human-readable name. */
export const RESOURCE_TYPE_META = [
  { type: "html", label: "HTML" },
  { type: "stylesheet", label: "CSS" },
  { type: "javascript", label: "JavaScript" },
  { type: "json", label: "JSON" },
  { type: "xml", label: "XML" },
  { type: "text", label: "Text" },
  { type: "image", label: "Image" },
  { type: "font", label: "Font" },
  { type: "media", label: "Audio / video" },
  { type: "wasm", label: "WebAssembly" },
  { type: "archive", label: "Archive" },
  { type: "document", label: "Document" },
  { type: "event-stream", label: "Event stream" },
  { type: "fetch-xhr", label: "Fetch / XHR" },
  { type: "websocket", label: "WebSocket" },
  { type: "data", label: "Structured data" },
] as const;

export type ResourceType = (typeof RESOURCE_TYPE_META)[number]["type"];

export function resourceTypeLabel(resourceType: ResourceType): string {
  return RESOURCE_TYPE_META.find(({ type }) => type === resourceType)!.label;
}

const MIME_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

const EXACT_TYPE_GROUPS: readonly [ResourceType, ReadonlySet<string>][] = [
  ["event-stream", new Set(["text/event-stream"])],
  ["html", new Set(["text/html", "application/xhtml+xml"])],
  ["stylesheet", new Set(["text/css"])],
  [
    "javascript",
    new Set([
      "application/ecmascript",
      "application/javascript",
      "application/node",
      "application/typescript",
      "application/x-ecmascript",
      "application/x-javascript",
      "text/ecmascript",
      "text/javascript",
      "text/typescript",
      "text/x-javascript",
    ]),
  ],
  [
    "json",
    new Set([
      "application/json",
      "application/json-seq",
      "application/ndjson",
      "application/x-ndjson",
      "text/json",
    ]),
  ],
  ["xml", new Set(["application/xml", "text/xml"])],
  [
    "font",
    new Set([
      "application/font-woff",
      "application/font-woff2",
      "application/font-sfnt",
      "application/vnd.ms-fontobject",
      "application/vnd.ms-opentype",
      "application/x-font-opentype",
      "application/x-font-ttf",
      "application/x-font-truetype",
      "application/x-font-woff",
      "application/x-font-woff2",
    ]),
  ],
  [
    "media",
    new Set([
      "application/dash+xml",
      "application/ogg",
      "application/vnd.apple.mpegurl",
      "application/x-mpegurl",
    ]),
  ],
  ["wasm", new Set(["application/wasm"])],
  [
    "archive",
    new Set([
      "application/gzip",
      "application/java-archive",
      "application/vnd.android.package-archive",
      "application/vnd.rar",
      "application/x-7z-compressed",
      "application/x-apple-diskimage",
      "application/x-bzip",
      "application/x-bzip2",
      "application/x-compress",
      "application/x-gzip",
      "application/x-gtar",
      "application/x-lzip",
      "application/x-lzma",
      "application/x-rar",
      "application/x-rar-compressed",
      "application/x-tar",
      "application/x-xz",
      "application/x-zip-compressed",
      "application/zip",
      "application/zstd",
    ]),
  ],
  [
    "document",
    new Set([
      "application/epub+zip",
      "application/msword",
      "application/pdf",
      "application/postscript",
      "application/rtf",
      "application/vnd.amazon.ebook",
      "application/vnd.apple.keynote",
      "application/vnd.apple.numbers",
      "application/vnd.apple.pages",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.visio",
      "application/x-pdf",
      "text/rtf",
    ]),
  ],
  [
    "text",
    new Set(["application/graphql", "application/sql", "application/x-yaml", "application/yaml"]),
  ],
  [
    "data",
    new Set([
      "application/cbor",
      "application/grpc",
      "application/grpc+proto",
      "application/msgpack",
      "application/octet-stream+protobuf",
      "application/protobuf",
      "application/vnd.google.protobuf",
      "application/x-msgpack",
      "application/x-protobuf",
      "application/x-www-form-urlencoded",
    ]),
  ],
];

const DOCUMENT_PREFIXES = [
  "application/vnd.oasis.opendocument.",
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.ms-excel.",
  "application/vnd.ms-powerpoint.",
  "application/vnd.ms-word.",
];

const KIND_FALLBACK: Record<ResourceKind, ResourceType | null> = {
  doc: "document",
  xhr: "fetch-xhr",
  js: "javascript",
  css: "stylesheet",
  img: "image",
  font: "font",
  media: "media",
  ws: "websocket",
  wasm: "wasm",
  other: null,
};

export function normalizeMime(mime: string | null): string | null {
  if (!mime) return null;
  const bare = mime.split(";", 1)[0].trim().toLowerCase();
  return MIME_TOKEN.test(bare) ? bare : null;
}

function exactResourceType(mime: string): ResourceType | null {
  return EXACT_TYPE_GROUPS.find(([, types]) => types.has(mime))?.[0] ?? null;
}

export function resourceTypeFromMime(mime: string | null): ResourceType | null {
  const normalized = normalizeMime(mime);
  if (!normalized) return null;

  const exact = exactResourceType(normalized);
  if (exact) return exact;

  const [topLevel, subtype] = normalized.split("/", 2);
  if (topLevel === "image") return "image";
  if (topLevel === "font") return "font";
  if (["audio", "video"].includes(topLevel)) return "media";
  if (DOCUMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "document";
  }
  if (subtype.endsWith("+json")) return "json";
  if (subtype.endsWith("+xml")) return "xml";
  if (topLevel === "text") return "text";
  if (topLevel === "multipart") return "data";
  return null;
}

export function resourceTypeForFlow(flow: Pick<FlowSummary, "mime" | "kind">): ResourceType | null {
  return resourceTypeFromMime(flow.mime) ?? KIND_FALLBACK[flow.kind];
}
