//! Save/Open of the captured traffic as a lossless `.germi` session file (JSON
//! with base64 bodies). This is the Fiddler/Charles model — nothing is persisted
//! automatically; the user explicitly saves and opens sessions.

use anyhow::Result;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};

const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    flows: Vec<SessionFlow>,
}

#[derive(Serialize, Deserialize)]
struct SessionFlow {
    method: String,
    uri: String,
    scheme: String,
    host: String,
    path: String,
    #[serde(default)]
    req_version: String,
    #[serde(default)]
    req_headers: Vec<(String, String)>,
    #[serde(default)]
    req_body: String, // base64
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    resp_version: String,
    #[serde(default)]
    resp_headers: Vec<(String, String)>,
    #[serde(default)]
    resp_body: String, // base64
    #[serde(default)]
    has_response: bool,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    ttfb_ms: Option<u64>,
    #[serde(default)]
    matched_rule: Option<String>,
    #[serde(default)]
    timestamp_ms: u64,
    /// The response's own timestamp; falls back to `timestamp_ms` when absent
    /// (older session files didn't carry it).
    #[serde(default)]
    resp_timestamp_ms: u64,
    #[serde(default)]
    comment: Option<String>,
}

fn b64e(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64d(s: &str) -> Vec<u8> {
    crate::body::base64_lenient(s).unwrap_or_else(|| {
        // Genuinely corrupt data: don't silently pretend the body was empty —
        // surface it so a damaged session is visible, not silently lossy.
        tracing::warn!("session: failed to decode a base64 body; using empty body");
        Vec::new()
    })
}

/// Serialize flows into a `.germi` session (JSON bytes).
pub fn export_session(flows: &[Flow]) -> Vec<u8> {
    let session = SessionFile {
        version: FORMAT_VERSION,
        flows: flows
            .iter()
            .map(|f| {
                let (status, resp_version, resp_headers, resp_body, has_response, resp_timestamp_ms) =
                    match &f.response {
                        Some(r) => (
                            Some(r.status),
                            r.version.clone(),
                            r.headers.clone(),
                            b64e(&r.body),
                            true,
                            r.timestamp_ms,
                        ),
                        None => (None, String::new(), Vec::new(), String::new(), false, 0),
                    };
                SessionFlow {
                    method: f.request.method.clone(),
                    uri: f.request.uri.clone(),
                    scheme: f.request.scheme.clone(),
                    host: f.request.host.clone(),
                    path: f.request.path.clone(),
                    req_version: f.request.version.clone(),
                    req_headers: f.request.headers.clone(),
                    req_body: b64e(&f.request.body),
                    status,
                    resp_version,
                    resp_headers,
                    resp_body,
                    has_response,
                    duration_ms: f.duration_ms,
                    ttfb_ms: f.ttfb_ms,
                    matched_rule: f.matched_rule.clone(),
                    timestamp_ms: f.request.timestamp_ms,
                    resp_timestamp_ms,
                    comment: f.comment.clone(),
                }
            })
            .collect(),
    };
    serde_json::to_vec(&session).unwrap_or_default()
}

/// Parse a `.germi` session back into flows (ids are assigned on insert).
pub fn import_session(bytes: &[u8]) -> Result<Vec<Flow>> {
    let session: SessionFile = serde_json::from_slice(bytes)?;
    // Refuse files from a newer, incompatible format rather than silently
    // misinterpreting their fields as v1.
    if session.version > FORMAT_VERSION {
        anyhow::bail!(
            "unsupported .germi session version {} (this build supports up to {})",
            session.version,
            FORMAT_VERSION
        );
    }
    let flows = session
        .flows
        .into_iter()
        .map(|sf| {
            let ts = if sf.timestamp_ms != 0 {
                sf.timestamp_ms
            } else {
                now_ms()
            };
            let request = CapturedRequest {
                method: sf.method,
                uri: sf.uri,
                scheme: sf.scheme,
                host: sf.host,
                path: sf.path,
                version: sf.req_version,
                headers: sf.req_headers,
                body: b64d(&sf.req_body),
                timestamp_ms: ts,
            };
            let response = if sf.has_response || sf.status.is_some() {
                let resp_ts = if sf.resp_timestamp_ms != 0 {
                    sf.resp_timestamp_ms
                } else {
                    ts
                };
                Some(CapturedResponse {
                    status: sf.status.unwrap_or(0),
                    version: sf.resp_version,
                    headers: sf.resp_headers,
                    body: b64d(&sf.resp_body),
                    timestamp_ms: resp_ts,
                })
            } else {
                None
            };
            Flow {
                id: String::new(),
                request,
                response,
                matched_rule: sf.matched_rule,
                duration_ms: sf.duration_ms,
                ttfb_ms: sf.ttfb_ms,
                comment: sf.comment,
                availability: None,
            }
        })
        .collect();
    Ok(flows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trips() {
        let flow = Flow {
            id: "x".into(),
            request: CapturedRequest {
                method: "GET".into(),
                uri: "https://h/p".into(),
                scheme: "https".into(),
                host: "h".into(),
                path: "/p".into(),
                version: "HTTP/1.1".into(),
                headers: vec![("Accept".into(), "*/*".into())],
                body: vec![1, 2, 3],
                timestamp_ms: 42,
            },
            response: Some(CapturedResponse {
                status: 200,
                version: "HTTP/1.1".into(),
                headers: vec![("Content-Type".into(), "text/plain".into())],
                body: b"hello".to_vec(),
                timestamp_ms: 50,
            }),
            matched_rule: Some("r".into()),
            duration_ms: Some(7),
            ttfb_ms: Some(3),
            comment: Some("note".into()),
            availability: None,
        };
        let bytes = export_session(&[flow]);
        let back = import_session(&bytes).unwrap();
        assert_eq!(back.len(), 1);
        let f = &back[0];
        assert_eq!(f.request.method, "GET");
        assert_eq!(f.request.body, vec![1, 2, 3]);
        assert_eq!(f.request.timestamp_ms, 42);
        let r = f.response.as_ref().unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"hello");
        assert_eq!(r.timestamp_ms, 50, "the response's own timestamp survives the round-trip");
        assert_eq!(f.matched_rule.as_deref(), Some("r"));
        assert_eq!(f.duration_ms, Some(7));
    }

    #[test]
    fn lenient_base64_tolerates_whitespace_and_padding() {
        // "hello" base64 with embedded newline and stripped padding still decodes.
        assert_eq!(b64d("aGVs\nbG8"), b"hello");
        assert_eq!(b64d("aGVsbG8="), b"hello");
        // Genuinely-corrupt input degrades to empty (and logs) rather than panic.
        assert_eq!(b64d("@@@not base64@@@"), Vec::<u8>::new());
    }

    #[test]
    fn rejects_newer_format_version() {
        let newer = format!(r#"{{"version":{},"flows":[]}}"#, FORMAT_VERSION + 1);
        let err = import_session(newer.as_bytes()).unwrap_err();
        assert!(err.to_string().contains("unsupported"));
        // The current version still parses.
        let ok = format!(r#"{{"version":{FORMAT_VERSION},"flows":[]}}"#);
        assert!(import_session(ok.as_bytes()).is_ok());
    }
}
