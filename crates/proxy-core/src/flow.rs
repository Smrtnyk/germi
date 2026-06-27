//! Captured traffic data model + the serializable DTOs that cross the IPC
//! boundary to the UI.
//!
//! Two shapes are emitted to the frontend:
//!   * [`FlowSummary`] — lightweight (no bodies); streamed live for the list.
//!   * [`FlowDetail`]  — full headers + bodies; fetched on demand per row.
//!
//! Keeping bodies *out* of the live stream is deliberate: the IPC bridge — not
//! the proxy — is the bottleneck, so we stream summaries and lazy-load detail.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A captured request, as seen by the proxy after TLS interception.
#[derive(Clone, Debug)]
pub struct CapturedRequest {
    pub method: String,
    pub uri: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timestamp_ms: u64,
}

/// A captured response (real upstream response, or one synthesized by a rule).
#[derive(Clone, Debug)]
pub struct CapturedResponse {
    pub status: u16,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timestamp_ms: u64,
}

/// A full request/response exchange held in the in-memory store.
#[derive(Clone, Debug)]
pub struct Flow {
    pub id: String,
    pub request: CapturedRequest,
    pub response: Option<CapturedResponse>,
    /// Name of the rule that fired on this flow, if any.
    pub matched_rule: Option<String>,
    pub duration_ms: Option<u64>,
    /// Time-to-first-byte: ms from request-buffered to response-headers received.
    pub ttfb_ms: Option<u64>,
    /// User-entered note/tag for triage (shown in the Comment column).
    pub comment: Option<String>,
    /// On-demand public-availability verdict (credential-stripped re-fetch);
    /// `None` until checked. In-memory only — not persisted to `.germi` sessions.
    pub availability: Option<Availability>,
    /// True when this flow was loaded from a file (HAR / SAZ / `.germi`) rather
    /// than captured live by the proxy. Drives the "imported" row marker and the
    /// `is:imported` filter, and is what "Delete captured" keeps (issue #49).
    pub imported: bool,
}

impl Flow {
    pub fn summary(&self) -> FlowSummary {
        let (status, resp_size, mime) = match &self.response {
            Some(r) => (
                Some(r.status),
                r.body.len() as u64,
                content_type_of(&r.headers),
            ),
            None => (None, 0, None),
        };
        FlowSummary {
            id: self.id.clone(),
            method: self.request.method.clone(),
            host: self.request.host.clone(),
            path: self.request.path.clone(),
            scheme: self.request.scheme.clone(),
            status,
            mime,
            kind: classify_kind(&self.request, self.response.as_ref()),
            req_size: self.request.body.len() as u64,
            resp_size,
            duration_ms: self.duration_ms,
            ttfb_ms: self.ttfb_ms,
            matched_rule: self.matched_rule.clone(),
            timestamp_ms: self.request.timestamp_ms,
            comment: self.comment.clone(),
            availability: self.availability.clone(),
            imported: self.imported,
            // Filled by the summary-building call sites that have settings access
            // (which header columns the user pinned). See `extract_header_columns`.
            extra: BTreeMap::new(),
        }
    }

    pub fn detail(&self, decode: bool, full: bool) -> FlowDetail {
        FlowDetail {
            id: self.id.clone(),
            method: self.request.method.clone(),
            uri: self.request.uri.clone(),
            host: self.request.host.clone(),
            path: self.request.path.clone(),
            scheme: self.request.scheme.clone(),
            req_version: self.request.version.clone(),
            request: MessageDetail::new(&self.request.headers, &self.request.body, decode, full),
            status: self.response.as_ref().map(|r| r.status),
            resp_version: self.response.as_ref().map(|r| r.version.clone()),
            response: self
                .response
                .as_ref()
                .map(|r| MessageDetail::new(&r.headers, &r.body, decode, full)),
            matched_rule: self.matched_rule.clone(),
            duration_ms: self.duration_ms,
            timestamp_ms: self.request.timestamp_ms,
        }
    }
}

/// Lightweight row for the live traffic list. No bodies.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub scheme: String,
    pub status: Option<u16>,
    pub mime: Option<String>,
    /// Inferred resource type (see `classify_kind`) — best-effort, not the
    /// browser's initiator-based truth.
    pub kind: ResourceKind,
    pub req_size: u64,
    pub resp_size: u64,
    pub duration_ms: Option<u64>,
    /// Time-to-first-byte in ms (request-buffered → response-headers).
    pub ttfb_ms: Option<u64>,
    pub matched_rule: Option<String>,
    pub timestamp_ms: u64,
    /// User note/tag for triage.
    pub comment: Option<String>,
    /// Public-availability verdict for a doc flow that has been checked on demand
    /// (drives the inline 🔓/🔒 row icon); `None` when not (yet) checked.
    pub availability: Option<Availability>,
    /// True when this flow was loaded from a file rather than captured live —
    /// drives the "imported" row marker and the `is:imported` filter (issue #49).
    pub imported: bool,
    /// Pinned header-column values, keyed by the column spec (e.g. `cf-ray` or
    /// `req:referer`). Only present headers are included.
    pub extra: BTreeMap<String, String>,
}

/// Extract the user-pinned header columns from a flow's headers. A spec is a
/// header name, optionally prefixed `req:` to read the request side (default is
/// the response). Keyed by the spec so the frontend can map column → value.
pub(crate) fn extract_header_columns(
    req: &CapturedRequest,
    resp: Option<&CapturedResponse>,
    specs: &[String],
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for spec in specs {
        let trimmed = spec.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (from_req, name) = match trimmed.strip_prefix("req:") {
            Some(n) => (true, n.trim()),
            None => (false, trimmed),
        };
        let headers = if from_req {
            Some(&req.headers)
        } else {
            resp.map(|r| &r.headers)
        };
        if let Some(headers) = headers {
            if let Some(v) = header(headers, name) {
                out.insert(spec.clone(), v.to_string());
            }
        }
    }
    out
}

/// Inferred resource type for the traffic-list type chips.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Doc,
    Xhr,
    Js,
    Css,
    Img,
    Font,
    Media,
    Ws,
    Wasm,
    Other,
}

/// Verdict of an on-demand "is this doc reachable without my credentials?" check
/// (issue #40): the request is re-issued stripped of cookies/auth and WITHOUT
/// following redirects, then classified by the response.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AvailabilityVerdict {
    /// Loaded without credentials (2xx).
    Public,
    /// Auth required or redirected away (401/403, or a 3xx to e.g. a login page).
    Protected,
    /// Gone without credentials (404/410).
    NotFound,
    /// Could not be checked (connect error / timeout / invalid target).
    Error,
    /// Reached the server but the status was inconclusive (other 4xx/5xx).
    Unknown,
}

/// Result of a public-availability check: the verdict, the re-checked status
/// code, and (for a redirect) where it pointed — the evidence the UI shows so a
/// user can decide whether to open the URL live or replay the session.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub verdict: AvailabilityVerdict,
    /// The status code observed on the credential-stripped re-fetch, if one came
    /// back at all (`None` on a network error / timeout).
    pub status: Option<u16>,
    /// For a redirect, the `Location` it pointed to (often a login page) — the
    /// strongest "needs the customer's auth" signal. `None` otherwise.
    pub location: Option<String>,
}

/// One side (request or response) of a flow, ready for the inspector.
/// Body is provided both as best-effort UTF-8 text and as base64 (binary-safe).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub headers: Vec<(String, String)>,
    pub body_text: String,
    pub body_base64: String,
    /// Full decoded body size in bytes (even when the body below is truncated).
    pub size: u64,
    /// Original Content-Encoding (e.g. "gzip"), if the body was encoded.
    pub encoding: Option<String>,
    /// Whether `body_text`/`body_base64` are the decompressed form.
    pub decoded: bool,
    /// True when the body was capped for display (fetch with `full` for all of it).
    pub truncated: bool,
    /// True when decompression itself hit the 64 MiB cap, so the decoded body is
    /// incomplete regardless of `full` — `size` is a floor, not the real length.
    pub decode_truncated: bool,
}

/// Bodies larger than this are capped for display unless `full` is requested —
/// shipping multi-MB bodies over IPC and rendering them is the slow path.
const DISPLAY_CAP: usize = 512 * 1024;

/// Whether a Content-Type is text-renderable (so we can skip base64 for it, and
/// so body-search can skip binary blobs).
pub(crate) fn is_textual(headers: &[(String, String)]) -> bool {
    let ct = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();
    ct.starts_with("text/")
        || [
            "json",
            "javascript",
            "ecmascript",
            "xml",
            "x-www-form-urlencoded",
            "csv",
            "html",
            "svg",
            "graphql",
        ]
        .iter()
        .any(|t| ct.contains(t))
}

impl MessageDetail {
    fn new(headers: &[(String, String)], body: &[u8], decode: bool, full: bool) -> Self {
        use std::borrow::Cow;
        let mut encoding = crate::body::content_encoding_of(headers);
        let (bytes, decoded, decode_truncated): (Cow<[u8]>, bool, bool) = if !decode {
            (Cow::Borrowed(body), false, false)
        } else if let Some((d, t)) = crate::body::decode_body(headers, body) {
            (Cow::Owned(d), true, t)
        } else {
            // Decode failed. If the raw body is actually valid text, the
            // Content-Encoding header is stale/incorrect (the body was never
            // really compressed) — drop the misleading label and present the
            // identity text it is, rather than a "failed" decode shown as a hex
            // dump. The header itself stays visible in the headers table.
            // Genuinely-undecodable binary is high-entropy and fails
            // looks_textual, so it still shows as hex.
            if encoding.is_some() && crate::body::looks_textual(body) {
                encoding = None;
            }
            (Cow::Borrowed(body), false, false)
        };

        let total = bytes.len();
        let truncated = !full && total > DISPLAY_CAP;
        let display: &[u8] = if truncated {
            &bytes[..DISPLAY_CAP]
        } else {
            &bytes[..]
        };

        // Skip base64 for text bodies (the UI renders those from `body_text`);
        // raw-compressed bytes — and binary bytes mislabeled with a text
        // content-type — still need it for the hex view.
        let needs_base64 = !is_textual(headers)
            || (!decoded && encoding.is_some())
            || std::str::from_utf8(display).is_err();

        Self {
            headers: headers.to_vec(),
            body_text: String::from_utf8_lossy(display).into_owned(),
            body_base64: if needs_base64 {
                base64::engine::general_purpose::STANDARD.encode(display)
            } else {
                String::new()
            },
            size: total as u64,
            encoding,
            decoded,
            truncated,
            decode_truncated,
        }
    }
}

/// Full exchange detail, fetched on demand when a row is selected.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowDetail {
    pub id: String,
    pub method: String,
    pub uri: String,
    pub host: String,
    pub path: String,
    pub scheme: String,
    pub req_version: String,
    pub request: MessageDetail,
    pub status: Option<u16>,
    pub resp_version: Option<String>,
    pub response: Option<MessageDetail>,
    pub matched_rule: Option<String>,
    pub duration_ms: Option<u64>,
    pub timestamp_ms: u64,
}

/// Events streamed to the UI as traffic flows. The frontend upserts by `id`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FlowEvent {
    /// A request was captured; response still pending.
    New { summary: FlowSummary },
    /// The response arrived (or was synthesized); row is now complete.
    Completed { summary: FlowSummary },
    /// The store was cleared.
    Cleared,
    /// Specific flows were removed by id (the user pruned them from the session);
    /// the UI drops exactly these rows.
    Removed { ids: Vec<String> },
    /// The event stream lagged (a subscriber fell behind) and some events were
    /// dropped; the UI should re-fetch the flow list to resynchronize.
    Resync,
}

/// Extract the bare content-type (without parameters) from a header list.
fn content_type_of(headers: &[(String, String)]) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.split(';').next().unwrap_or(v).trim().to_string())
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Best-effort resource-type inference for a flow. A proxy has no browser
/// "initiator", so we approximate, in priority order: WebSocket handshake →
/// `Sec-Fetch-Dest` (near-browser fidelity) → `Sec-Fetch-Mode` → `X-Requested-With`
/// → response Content-Type → URL extension → `Accept` hint.
fn classify_kind(req: &CapturedRequest, resp: Option<&CapturedResponse>) -> ResourceKind {
    use ResourceKind::{Ws, Doc, Js, Css, Font, Img, Media, Other, Xhr, Wasm};
    let h = &req.headers;

    // 1. WebSocket handshake (most reliable; must precede Sec-Fetch-Dest:empty).
    if header(h, "upgrade")
        .is_some_and(|u| u.to_ascii_lowercase().contains("websocket"))
        || resp.is_some_and(|r| r.status == 101)
    {
        return Ws;
    }

    // 2. Sec-Fetch-Dest — the only header that recovers the true destination.
    if let Some(dest) = header(h, "sec-fetch-dest") {
        match dest.to_ascii_lowercase().as_str() {
            "document" | "iframe" | "frame" | "embed" | "object" => return Doc,
            "script" => return Js,
            "style" => return Css,
            "font" => return Font,
            "image" => return Img,
            "audio" | "video" | "track" => return Media,
            "empty" | "" => {} // fetch/xhr/beacon — fall through to content-type
            _ => return Other, // worker, serviceworker, manifest, report, ...
        }
    }

    // 3. Sec-Fetch-Mode.
    if let Some(mode) = header(h, "sec-fetch-mode") {
        match mode.to_ascii_lowercase().as_str() {
            "navigate" => return Doc,
            "websocket" => return Ws,
            _ => {}
        }
    }

    // 4. Legacy XHR signal.
    if header(h, "x-requested-with")
        .is_some_and(|v| v.eq_ignore_ascii_case("XMLHttpRequest"))
    {
        return Xhr;
    }

    // 5. Response Content-Type.
    let ct = resp
        .and_then(|r| content_type_of(&r.headers))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ct.is_empty() {
        if ct.contains("html") {
            return Doc;
        }
        if ct.contains("css") {
            return Css;
        }
        if ct.contains("javascript") || ct.contains("ecmascript") {
            return Js;
        }
        if ct.contains("wasm") {
            return Wasm;
        }
        if ct.starts_with("image/") {
            return Img;
        }
        if ct.starts_with("font/") || ct.contains("font") {
            return Font;
        }
        if ct.starts_with("audio/") || ct.starts_with("video/") {
            return Media;
        }
        if ct.contains("json") || ct.contains("xml") || ct.starts_with("text/") {
            return Xhr;
        }
    }

    // 6. URL extension fallback.
    let path = req.path.split('?').next().unwrap_or("");
    let ext = match (path.rfind('.'), path.rfind('/')) {
        (Some(dot), slash) if Some(dot) > slash => &path[dot + 1..],
        _ => "",
    }
    .to_ascii_lowercase();
    match ext.as_str() {
        "css" => return Css,
        "js" | "mjs" | "cjs" => return Js,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "ico" | "bmp" => return Img,
        "woff" | "woff2" | "ttf" | "otf" | "eot" => return Font,
        "mp4" | "webm" | "mp3" | "ogg" | "m4a" | "mov" | "wav" => return Media,
        "wasm" => return Wasm,
        "html" | "htm" => return Doc,
        "json" => return Xhr,
        _ => {}
    }

    // 7. Weak Accept hint.
    if let Some(accept) = header(h, "accept") {
        let a = accept.to_ascii_lowercase();
        if a.starts_with("text/html") {
            return Doc;
        }
        if a.contains("application/json") || a.starts_with("*/*") {
            return Xhr;
        }
    }

    Other
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(headers: &[(&str, &str)], path: &str) -> CapturedRequest {
        CapturedRequest {
            method: "GET".into(),
            uri: format!("https://h{path}"),
            scheme: "https".into(),
            host: "h".into(),
            path: path.into(),
            version: "HTTP/1.1".into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: vec![],
            timestamp_ms: 0,
        }
    }
    fn resp(ct: &str) -> CapturedResponse {
        CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("content-type".into(), ct.into())],
            body: vec![],
            timestamp_ms: 0,
        }
    }

    #[test]
    fn kind_prefers_sec_fetch_dest() {
        assert_eq!(
            classify_kind(&req(&[("sec-fetch-dest", "script")], "/x"), None),
            ResourceKind::Js
        );
    }

    #[test]
    fn kind_falls_back_to_content_type_then_ext() {
        assert_eq!(
            classify_kind(&req(&[], "/api/users"), Some(&resp("application/json"))),
            ResourceKind::Xhr
        );
        assert_eq!(
            classify_kind(&req(&[], "/p"), Some(&resp("text/html"))),
            ResourceKind::Doc
        );
        assert_eq!(
            classify_kind(&req(&[], "/a/b.css?v=1"), None),
            ResourceKind::Css
        );
        assert_eq!(
            classify_kind(&req(&[], "/img/logo.png"), None),
            ResourceKind::Img
        );
    }

    #[test]
    fn kind_detects_websocket() {
        assert_eq!(
            classify_kind(&req(&[("upgrade", "websocket")], "/ws"), None),
            ResourceKind::Ws
        );
    }

    #[test]
    fn extracts_pinned_header_columns() {
        let request = req(&[("referer", "https://app")], "/x");
        let mut response = resp("text/html");
        response.headers.push(("cf-ray".into(), "abc123".into()));
        let specs = vec![
            "cf-ray".to_string(),    // response side (default)
            "req:referer".to_string(), // request side
            "x-missing".to_string(), // absent → skipped
        ];
        let extra = extract_header_columns(&request, Some(&response), &specs);
        assert_eq!(extra.get("cf-ray").map(String::as_str), Some("abc123"));
        assert_eq!(extra.get("req:referer").map(String::as_str), Some("https://app"));
        assert!(!extra.contains_key("x-missing"));
    }

    fn h(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn stale_content_encoding_on_text_body_is_shown_as_text() {
        // A body that declares `Content-Encoding: br` but is actually identity
        // text (stale/incorrect header) must render as text — not a "br · failed"
        // hex wall. This is the regression reported by users.
        let headers = vec![h("content-type", "application/json"), h("content-encoding", "br")];
        let md = MessageDetail::new(&headers, b"{\"ok\":true}", true, true);
        assert_eq!(md.body_text, "{\"ok\":true}");
        assert_eq!(md.encoding, None, "stale encoding label is dropped");
        assert!(!md.decoded);
        assert!(md.body_base64.is_empty(), "a textual body needs no hex/base64");
    }

    #[test]
    fn real_brotli_body_still_decodes() {
        use std::io::Write;
        let mut compressed = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            w.write_all(b"hello brotli world").unwrap();
        }
        let headers = vec![h("content-type", "text/plain"), h("content-encoding", "br")];
        let md = MessageDetail::new(&headers, &compressed, true, true);
        assert_eq!(md.body_text, "hello brotli world");
        assert_eq!(md.encoding.as_deref(), Some("br"));
        assert!(md.decoded);
    }

    #[test]
    fn undecodable_binary_with_encoding_stays_binary() {
        // Genuinely-undecodable binary keeps its encoding label and provides
        // base64 for the hex view — it must NOT be reinterpreted as text.
        let headers = vec![h("content-encoding", "gzip")];
        let body: Vec<u8> =
            [0x00, 0xff, 0xfe, 0x80, 0x9c, 0x01, 0x02, 0x88, 0xaa, 0x55].repeat(40);
        let md = MessageDetail::new(&headers, &body, true, true);
        assert_eq!(md.encoding.as_deref(), Some("gzip"));
        assert!(!md.decoded);
        assert!(!md.body_base64.is_empty());
    }
}
