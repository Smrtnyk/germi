//! Captured traffic data model + the serializable DTOs that cross the IPC
//! boundary to the UI.
//!
//! Two shapes are emitted to the frontend:
//!   * [`FlowSummary`] — lightweight (no bodies); streamed live for the list.
//!   * [`FlowDetail`]  — full headers + bodies; fetched on demand per row.
//!
//! Keeping bodies *out* of the live stream is deliberate: the IPC bridge — not
//! the proxy — is the bottleneck, so we stream summaries and lazy-load detail.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
            matched_rule: self.matched_rule.clone(),
            timestamp_ms: self.request.timestamp_ms,
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
    pub matched_rule: Option<String>,
    pub timestamp_ms: u64,
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
        let encoding = crate::body::content_encoding_of(headers);
        let (bytes, decoded): (Cow<[u8]>, bool) = match (decode, &encoding) {
            (true, Some(enc)) => match crate::body::try_decompress(enc, body) {
                Some(d) => (Cow::Owned(d), true),
                None => (Cow::Borrowed(body), false),
            },
            _ => (Cow::Borrowed(body), false),
        };

        let total = bytes.len();
        let truncated = !full && total > DISPLAY_CAP;
        let display: &[u8] = if truncated {
            &bytes[..DISPLAY_CAP]
        } else {
            &bytes[..]
        };

        // Skip base64 for text bodies (the UI renders those from `body_text`);
        // raw-compressed bytes still need it for the hex view.
        let needs_base64 = !is_textual(headers) || (!decoded && encoding.is_some());

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
    use ResourceKind::*;
    let h = &req.headers;

    // 1. WebSocket handshake (most reliable; must precede Sec-Fetch-Dest:empty).
    if header(h, "upgrade")
        .map(|u| u.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false)
        || resp.map(|r| r.status == 101).unwrap_or(false)
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
        .map(|v| v.eq_ignore_ascii_case("XMLHttpRequest"))
        .unwrap_or(false)
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
}
