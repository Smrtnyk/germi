import { describe, expect, it } from "vitest";

import {
  normalizeMime,
  RESOURCE_TYPE_META,
  resourceTypeForFlow,
  resourceTypeFromMime,
  resourceTypeLabel,
} from "./resourceType";
import type { ResourceKind } from "./types";

function flow(mime: string | null, kind: ResourceKind = "other") {
  return { mime, kind };
}

describe("normalizeMime", () => {
  it("removes parameters and normalizes whitespace and case", () => {
    expect(normalizeMime(" Text/HTML ; Charset=UTF-8 ")).toBe("text/html");
  });

  it.each(["", "html", "application", "application/", "/json", "text / plain"])(
    "rejects malformed MIME value %j",
    (mime) => {
      expect(normalizeMime(mime)).toBeNull();
    },
  );
});

describe("resource type metadata", () => {
  it("provides one unique human-readable label for every icon family", () => {
    expect(new Set(RESOURCE_TYPE_META.map(({ type }) => type)).size).toBe(
      RESOURCE_TYPE_META.length,
    );
    expect(new Set(RESOURCE_TYPE_META.map(({ label }) => label)).size).toBe(
      RESOURCE_TYPE_META.length,
    );
    expect(resourceTypeLabel("javascript")).toBe("JavaScript");
    expect(resourceTypeLabel("fetch-xhr")).toBe("Fetch / XHR");
  });
});

describe("resourceTypeFromMime", () => {
  it.each([
    ["text/html", "html"],
    ["application/xhtml+xml", "html"],
    ["text/css", "stylesheet"],
    ["text/javascript", "javascript"],
    ["application/vnd.api+json", "json"],
    ["application/problem+json", "json"],
    ["application/atom+xml", "xml"],
    ["text/plain", "text"],
    ["text/csv", "text"],
    ["image/svg+xml", "image"],
    ["image/avif", "image"],
    ["font/woff2", "font"],
    ["application/vnd.ms-fontobject", "font"],
    ["application/font-sfnt", "font"],
    ["application/font-woff2", "font"],
    ["application/x-font-woff2", "font"],
    ["audio/ogg", "media"],
    ["video/mp4", "media"],
    ["application/vnd.apple.mpegurl", "media"],
    ["application/wasm", "wasm"],
    ["application/zip", "archive"],
    ["application/x-7z-compressed", "archive"],
    ["application/vnd.android.package-archive", "archive"],
    ["application/java-archive", "archive"],
    ["application/x-zip-compressed", "archive"],
    ["application/x-gtar", "archive"],
    ["application/pdf", "document"],
    ["application/vnd.ms-excel", "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["application/vnd.ms-excel.sheet.macroEnabled.12", "document"],
    ["application/vnd.apple.pages", "document"],
    ["application/x-pdf", "document"],
    ["application/vnd.visio", "document"],
    ["text/event-stream", "event-stream"],
    ["multipart/form-data", "data"],
    ["application/cbor", "data"],
  ] as const)("maps %s to %s", (mime, expected) => {
    expect(resourceTypeFromMime(mime)).toBe(expected);
  });

  it("keeps a vendor XML image in the image family", () => {
    expect(resourceTypeFromMime("image/svg+xml; charset=utf-8")).toBe("image");
  });

  it("normalizes case and parameters before matching structured suffixes", () => {
    expect(resourceTypeFromMime(" Application/Vnd.Api+JSON ; profile=v1 ")).toBe("json");
    expect(resourceTypeFromMime(" APPLICATION/ATOM+XML; CHARSET=UTF-8 ")).toBe("xml");
  });

  it.each([null, "", "not-a-mime", "application/x-private", "application/octet-stream"])(
    "does not invent a MIME family for %j",
    (mime) => {
      expect(resourceTypeFromMime(mime)).toBeNull();
    },
  );
});

describe("resourceTypeForFlow", () => {
  it("prefers a recognized response MIME over the inferred kind", () => {
    expect(resourceTypeForFlow(flow("TEXT/CSS; charset=UTF-8", "img"))).toBe("stylesheet");
  });

  it.each([
    ["doc", "document"],
    ["xhr", "fetch-xhr"],
    ["js", "javascript"],
    ["css", "stylesheet"],
    ["img", "image"],
    ["font", "font"],
    ["media", "media"],
    ["ws", "websocket"],
    ["wasm", "wasm"],
  ] as const)("falls back from a missing MIME for %s", (kind, expected) => {
    expect(resourceTypeForFlow(flow(null, kind))).toBe(expected);
  });

  it("uses the inferred kind when the response MIME is malformed or unrecognized", () => {
    expect(resourceTypeForFlow(flow("not-a-mime", "js"))).toBe("javascript");
    expect(resourceTypeForFlow(flow("application/x-private", "xhr"))).toBe("fetch-xhr");
  });

  it("uses a fetch/XHR icon, not a data-format icon, while its response is pending", () => {
    expect(resourceTypeForFlow(flow(null, "xhr"))).toBe("fetch-xhr");
  });

  it.each([null, "application/octet-stream", "application/x-private", "not-a-mime"])(
    "omits a genuinely unknown type for %j",
    (mime) => {
      expect(resourceTypeForFlow(flow(mime))).toBeNull();
    },
  );
});
