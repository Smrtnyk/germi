import type { FlowDetail, MessageDetail } from "./types";

/** Build a `MessageDetail` for tests, overriding only the fields that matter. */
export function message(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    headers: [],
    bodyText: "",
    bodyBase64: "",
    size: 0,
    encoding: null,
    decoded: false,
    truncated: false,
    decodeTruncated: false,
    ...overrides,
  };
}

/** Build a `FlowDetail` for tests, overriding only the fields that matter. */
export function detail(overrides: Partial<FlowDetail> = {}): FlowDetail {
  return {
    id: "1",
    method: "GET",
    uri: "https://example.com/",
    host: "example.com",
    path: "/",
    scheme: "https",
    reqVersion: "HTTP/1.1",
    request: message(),
    status: 200,
    respVersion: "HTTP/1.1",
    response: null,
    matchedRule: null,
    durationMs: null,
    timestampMs: 0,
    ...overrides,
  };
}
