import { headersToText } from "./curl";
import { flowDetailUrl } from "./flowUrl";
import type { FlowDetail } from "./types";

const REASONS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  511: "Network Authentication Required",
};

/** Canonical reason phrase for a status code, or "" when unknown. */
export function reasonPhrase(status: number): string {
  return REASONS[status] ?? "";
}

/** Fiddler-style request line: `METHOD absolute-uri HTTP/x.y`. */
export function requestLine(detail: FlowDetail): string {
  const target = flowDetailUrl(detail);
  return `${detail.method} ${target} ${detail.reqVersion}`;
}

/** Response status line: `HTTP/x.y CODE Reason` (reason omitted when unknown). */
export function statusLine(detail: FlowDetail): string {
  const version = detail.respVersion ?? "HTTP/1.1";
  if (detail.status === null) return version;
  const reason = reasonPhrase(detail.status);
  return reason ? `${version} ${detail.status} ${reason}` : `${version} ${detail.status}`;
}

/**
 * Assemble a wire-format message: the start line, the header block, then a blank
 * line. A non-empty body follows the blank line; a body-less message ends on the
 * header-terminating blank line (matching the trailing newline seen in Fiddler).
 */
export function rawMessage(
  startLine: string,
  headers: [string, string][],
  bodyText: string,
): string {
  const head = headers.length ? `${startLine}\n${headersToText(headers)}` : startLine;
  return bodyText ? `${head}\n\n${bodyText}` : `${head}\n\n`;
}
