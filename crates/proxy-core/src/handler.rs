//! The hudsucker handler: captures every request/response, applies rules, and
//! streams events.
//!
//! hudsucker clones the handler and uses the *same clone* for a given
//! request/response pair, so we stash the in-flight flow id + start time on
//! `self` in `handle_request` and read them back in `handle_response`.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use http_body_util::combinators::BoxBody;
use http_body_util::BodyExt;
use hudsucker::hyper::body::{Body as HttpBody, Bytes, Frame, SizeHint};
use hudsucker::hyper::header::{HeaderName, HeaderValue, CONTENT_LENGTH, HOST};
use hudsucker::hyper::{HeaderMap, Request, Response};
use hudsucker::tokio_tungstenite::tungstenite::Message;
use hudsucker::{
    Body, Error, HttpContext, HttpHandler, RequestOrResponse, WebSocketContext, WebSocketHandler,
};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};
use crate::rules::{RequestOutcome, SyntheticResponse};
use crate::shared::Shared;

/// A body is buffered into memory (to capture it and run rewrite rules) up to
/// this size. Bodies whose declared `Content-Length` exceeds it are forwarded
/// **unbuffered** (streamed through untouched, with only a body-less placeholder
/// captured) so a huge or hostile transfer can't be collected entirely into RAM.
/// Bodies with no declared length are buffered up to this bound and, if they
/// exceed it, the FULL body is still forwarded (capped prefix + remaining stream)
/// while only the prefix is captured — so the wire is never truncated.
const MAX_CAPTURE_BODY: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct CaptureHandler {
    shared: Arc<Shared>,
    inflight: Option<Inflight>,
}

#[derive(Clone)]
struct Inflight {
    id: String,
    start: Instant,
}

impl CaptureHandler {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            inflight: None,
        }
    }
}

impl HttpHandler for CaptureHandler {
    async fn handle_request(
        &mut self,
        _ctx: &HttpContext,
        req: Request<Body>,
    ) -> RequestOrResponse {
        let (mut parts, body) = req.into_parts();

        let host = parts
            .headers
            .get(HOST)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| parts.uri.host().map(|s| s.to_string()))
            .unwrap_or_default();

        // Bypassed hosts (excluded, or filtered out): forward plain HTTP without
        // recording — and without buffering the body. (Bypassed HTTPS is tunneled
        // at CONNECT via `should_intercept`.)
        if self.shared.should_bypass(&host) {
            self.inflight = None;
            return Request::from_parts(parts, body).into();
        }

        // Large declared bodies are forwarded unbuffered (rewrite rules can't
        // apply to them); everything else is captured up to MAX_CAPTURE_BODY and,
        // if larger, still forwarded in full (prefix + remaining stream).
        let oversized = declared_len(&parts.headers).is_some_and(|n| n > MAX_CAPTURE_BODY);
        let (body_bytes, stream_forward): (Vec<u8>, Option<Body>) = if oversized {
            (Vec::new(), Some(body))
        } else {
            buffer_capped(body, MAX_CAPTURE_BODY as usize).await
        };

        let scheme = parts
            .uri
            .scheme_str()
            .unwrap_or("https") // intercepted CONNECT traffic is https
            .to_string();
        let path = parts
            .uri
            .path_and_query().map_or_else(|| parts.uri.path().to_string(), |p| p.as_str().to_string());

        let captured = CapturedRequest {
            method: parts.method.as_str().to_string(),
            uri: parts.uri.to_string(),
            scheme,
            host,
            path,
            version: format!("{:?}", parts.version),
            headers: header_pairs(&parts.headers),
            body: body_bytes.clone(),
            timestamp_ms: now_ms(),
        };

        let outcome = self
            .shared
            .autoresponder
            .read()
            .map_or(RequestOutcome::Continue {
                set_headers: vec![],
            }, |ar| ar.evaluate_request(&captured));

        let id = self.shared.next_id();
        let start = Instant::now();

        // Emit the request immediately (response pending).
        self.shared.record_new(Flow {
            id: id.clone(),
            request: captured,
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
        });

        match outcome {
            RequestOutcome::Respond { rule, response } => {
                let out = build_response(&response);
                self.complete_synthetic(&id, &rule, response);
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Block { rule } => {
                let synthetic = SyntheticResponse {
                    status: 403,
                    headers: vec![("content-type".to_string(), "text/plain".to_string())],
                    body: b"Blocked by Germi".to_vec(),
                };
                self.complete_synthetic(&id, &rule, synthetic.clone());
                self.inflight = None;
                build_response(&synthetic).into()
            }
            RequestOutcome::Continue { set_headers } => {
                self.inflight = Some(Inflight { id, start });
                for (k, v) in &set_headers {
                    if let (Ok(name), Ok(val)) = (
                        HeaderName::from_bytes(k.as_bytes()),
                        HeaderValue::from_str(v),
                    ) {
                        parts.headers.insert(name, val);
                    }
                }
                // Forward the streaming remainder (oversized/truncated) or a body
                // rebuilt from the captured bytes.
                let forward = stream_forward.unwrap_or_else(|| Body::from(body_bytes));
                Request::from_parts(parts, forward).into()
            }
        }
    }

    async fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> Response<Body> {
        let inflight = self.inflight.take();
        let (parts, body) = res.into_parts();
        // Response headers are in hand now; the body still streams. This instant
        // is the time-to-first-byte (request-buffered → response-headers).
        let ttfb = inflight
            .as_ref()
            .map(|i| i.start.elapsed().as_millis() as u64);

        // Large declared response bodies stream straight through to the client
        // without buffering; only a body-less placeholder is captured.
        if declared_len(&parts.headers).is_some_and(|n| n > MAX_CAPTURE_BODY) {
            if let Some(inflight) = inflight {
                let duration = inflight.start.elapsed().as_millis() as u64;
                let captured = CapturedResponse {
                    status: parts.status.as_u16(),
                    version: format!("{:?}", parts.version),
                    headers: header_pairs(&parts.headers),
                    body: Vec::new(),
                    timestamp_ms: now_ms(),
                };
                self.shared
                    .record_complete(&inflight.id, captured, duration, ttfb, None);
            }
            return Response::from_parts(parts, body);
        }

        let (body_bytes, stream_forward) = buffer_capped(body, MAX_CAPTURE_BODY as usize).await;

        // Body exceeded the cap: too large to safely rewrite. Capture the prefix
        // and forward the full body (prefix + remaining stream) with the ORIGINAL
        // headers — the body is unmodified, so content-length/encoding stay valid.
        if let Some(forward) = stream_forward {
            if let Some(inflight) = inflight {
                let duration = inflight.start.elapsed().as_millis() as u64;
                let captured = CapturedResponse {
                    status: parts.status.as_u16(),
                    version: format!("{:?}", parts.version),
                    headers: header_pairs(&parts.headers),
                    body: body_bytes,
                    timestamp_ms: now_ms(),
                };
                self.shared
                    .record_complete(&inflight.id, captured, duration, ttfb, None);
            }
            return Response::from_parts(parts, forward);
        }

        let mut captured = CapturedResponse {
            status: parts.status.as_u16(),
            version: format!("{:?}", parts.version),
            headers: header_pairs(&parts.headers),
            body: body_bytes,
            timestamp_ms: now_ms(),
        };

        let mut matched = None;
        if let Some(inflight) = &inflight {
            if let Some(req) = self.shared.get_request(&inflight.id) {
                if let Ok(ar) = self.shared.autoresponder.read() {
                    matched = ar.apply_response(&req, &mut captured);
                }
            }
        }

        let out = build_captured_response(&captured);

        if let Some(inflight) = inflight {
            let duration = inflight.start.elapsed().as_millis() as u64;
            self.shared
                .record_complete(&inflight.id, captured, duration, ttfb, matched);
        }

        // Throttling: simulate a slow response. Applied after recording, so the
        // captured duration stays real while the client experiences the delay.
        let delay = self.shared.response_delay_ms();
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        out
    }

    /// Decide whether to MITM a CONNECT. Bypassed hosts return `false`, so
    /// hudsucker blind-tunnels them (no certificate, decryption, or capture).
    async fn should_intercept(&mut self, _ctx: &HttpContext, req: &Request<Body>) -> bool {
        let host = req.uri().host().unwrap_or_default();
        !self.shared.should_bypass(host)
    }
}

impl CaptureHandler {
    fn complete_synthetic(&self, id: &str, rule: &str, response: SyntheticResponse) {
        let captured = CapturedResponse {
            status: response.status,
            version: "HTTP/1.1".to_string(),
            headers: response.headers,
            body: response.body,
            timestamp_ms: now_ms(),
        };
        self.shared
            .record_complete(id, captured, 0, Some(0), Some(rule.to_string()));
    }
}

impl WebSocketHandler for CaptureHandler {
    async fn handle_message(&mut self, _ctx: &WebSocketContext, msg: Message) -> Option<Message> {
        // MVP: transparent pass-through. Phase 2 captures/edits WS frames here.
        Some(msg)
    }
}

/// The declared `Content-Length` of a message, if present and parseable.
fn declared_len(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// A body that emits a buffered `prefix` first, then streams the remainder of an
/// inner body. Lets us forward a large body in full (so the wire is never
/// truncated) while having captured only a capped prefix of it.
struct PrefixThenBody {
    prefix: Option<Bytes>,
    inner: Body,
}

impl HttpBody for PrefixThenBody {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let me = self.get_mut();
        if let Some(prefix) = me.prefix.take() {
            return Poll::Ready(Some(Ok(Frame::data(prefix))));
        }
        Pin::new(&mut me.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.prefix.is_none() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// Buffer a body for capture, hard-capped at `MAX_CAPTURE_BODY` so an
/// undeclared-length (e.g. chunked) body can't exhaust memory. Returns the
/// captured bytes (≤ cap) and, ONLY when the body exceeded the cap, a forward
/// body that re-emits the read prefix then streams the remainder — so the FULL
/// content still reaches the wire while only the prefix is captured. When the
/// body fit within the cap, the second element is `None` and the caller forwards
/// the captured bytes directly (after any rewrite).
async fn buffer_capped(body: Body, cap: usize) -> (Vec<u8>, Option<Body>) {
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    // A `Some(Err)` or `None` frame ends the stream (loop exits); a body that
    // exceeds the cap returns early with a streaming-remainder forward body.
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(data) = frame.into_data() {
            buf.extend_from_slice(&data);
            if buf.len() >= cap {
                let prefix = Bytes::from(buf.clone());
                buf.truncate(cap);
                let forward = Body::from(BoxBody::new(PrefixThenBody {
                    prefix: Some(prefix),
                    inner: body,
                }));
                return (buf, Some(forward));
            }
        }
    }
    (buf, None)
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        // Header values may legally carry obs-text bytes (>= 0x80), e.g. raw
        // UTF-8 in Set-Cookie / Content-Disposition. `to_str()` rejects those, so
        // use a lossy decode (a round-trip for valid UTF-8) instead of blanking
        // the value — and rebuild via `HeaderValue::from_bytes` (see build_parts).
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// Build a hyper response from a synthetic (rule-generated) response.
fn build_response(synthetic: &SyntheticResponse) -> Response<Body> {
    build_parts(synthetic.status, &synthetic.headers, &synthetic.body)
}

/// Build a hyper response from a captured (possibly rewritten) response.
fn build_captured_response(captured: &CapturedResponse) -> Response<Body> {
    build_parts(captured.status, &captured.headers, &captured.body)
}

fn build_parts(status: u16, headers: &[(String, String)], body: &[u8]) -> Response<Body> {
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        // Drop length/encoding headers; hyper recomputes content-length from the
        // (possibly rewritten) body, avoiding mismatches.
        if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        // from_bytes (not from_str) so obs-text values captured via the lossy
        // decode in `header_pairs` are forwarded byte-for-byte when valid UTF-8.
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(Body::from(body.to_vec()))
        .unwrap_or_else(|_| Response::new(Body::from(body.to_vec())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn buffer_capped_small_body_is_fully_captured() {
        let (captured, forward) = buffer_capped(Body::from(vec![1u8, 2, 3]), 64).await;
        assert_eq!(captured, vec![1, 2, 3]);
        assert!(forward.is_none(), "body within the cap needs no streaming forward");
    }

    #[tokio::test]
    async fn buffer_capped_truncates_capture_but_forwards_full_body() {
        let data = vec![b'x'; 100];
        let (captured, forward) = buffer_capped(Body::from(data.clone()), 40).await;
        // Capture is capped...
        assert_eq!(captured.len(), 40);
        // ...but the body forwarded onward is the FULL, untruncated content.
        let full = forward
            .expect("oversized body returns a streaming forward")
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(full.len(), 100);
        assert_eq!(&full[..], &data[..]);
    }
}
