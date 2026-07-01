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
use hudsucker::hyper::header::{HeaderName, HeaderValue, CONTENT_LENGTH, HOST, UPGRADE};
use hudsucker::hyper::{HeaderMap, Request, Response, Uri};
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

        let host = request_host(&parts.uri, &parts.headers);

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
            let (bytes, forward, _complete) = buffer_capped(body, MAX_CAPTURE_BODY as usize).await;
            (bytes, forward)
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

        let outcome = {
            let ar = self.shared.autoresponder.read();
            let cursors = self.shared.cursors.lock();
            match (ar, cursors) {
                (Ok(ar), Ok(mut cursors)) => ar.evaluate_request_stateful(&captured, &mut cursors),
                _ => RequestOutcome::Continue {
                    set_headers: vec![],
                },
            }
        };

        let id = self.shared.next_id();
        let start = Instant::now();

        // Emit the request immediately (response pending).
        self.shared.record_new(Flow {
            id: id.clone(),
            seq: self.shared.next_seq(),
            request: captured,
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        });

        match outcome {
            RequestOutcome::Respond { rule, response, .. } => {
                let out = build_response(&response);
                self.complete_synthetic(&id, &rule, response);
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Block { rule, .. } => {
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
                self.inflight = Some(Inflight {
                    id: id.clone(),
                    start,
                });
                for (k, v) in &set_headers {
                    if let (Ok(name), Ok(val)) = (
                        HeaderName::from_bytes(k.as_bytes()),
                        HeaderValue::from_str(v),
                    ) {
                        parts.headers.insert(name, val);
                    }
                }
                // A successful WebSocket upgrade hands the connection to the WS
                // handler and `handle_response` never fires, which would strand a
                // forever-"pending" row. Record a tentative 101 now; if a real
                // response does arrive (e.g. the server rejects the upgrade), it
                // overwrites this entry by the same id.
                if is_websocket_upgrade(&parts.headers) {
                    self.record_ws_upgrade(&id);
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

        // A bypassed (excluded/filtered) request was forwarded without recording,
        // so there is no in-flight entry. Forward its response untouched — no
        // buffering, no rewrite, no throttle — honoring the opt-out. (Synthesized
        // responses never reach handle_response, so inflight == None ⟺ bypassed.)
        let Some(inflight) = inflight else {
            return Response::from_parts(parts, body);
        };

        // Response headers are in hand now; the body still streams. This instant
        // is the time-to-first-byte (request-buffered → response-headers).
        let ttfb = Some(inflight.start.elapsed().as_millis() as u64);

        // Large declared response bodies stream straight through to the client
        // without buffering; only a body-less placeholder is captured.
        if declared_len(&parts.headers).is_some_and(|n| n > MAX_CAPTURE_BODY) {
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
            self.throttle().await;
            return Response::from_parts(parts, body);
        }

        let (body_bytes, stream_forward, _complete) =
            buffer_capped(body, MAX_CAPTURE_BODY as usize).await;

        // Body exceeded the cap, or the upstream stream errored mid-body: too
        // large / incomplete to safely rewrite. Capture the prefix and forward
        // the body as-is — the remaining stream (prefix + rest), or the prefix
        // then a propagated error so a truncated transfer is never presented to
        // the client as a clean, complete response — with the ORIGINAL headers.
        if let Some(forward) = stream_forward {
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
            self.throttle().await;
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
        if let Some(req) = self.shared.get_request(&inflight.id) {
            // Lock order autoresponder→cursors matches handle_request, so the two
            // never deadlock; held only for this synchronous rewrite (no .await).
            if let (Ok(ar), Ok(mut cursors)) =
                (self.shared.autoresponder.read(), self.shared.cursors.lock())
            {
                matched = ar.apply_response_stateful(&req, &mut captured, &mut cursors);
            }
        }

        let out = build_captured_response(&captured);

        let duration = inflight.start.elapsed().as_millis() as u64;
        self.shared
            .record_complete(&inflight.id, captured, duration, ttfb, matched);

        self.throttle().await;
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
    /// Apply the configured response-delay throttle (simulate a slow response),
    /// after recording so the captured duration stays real. Skipped for bypassed
    /// traffic (which returns before reaching here).
    async fn throttle(&self) {
        let delay = self.shared.response_delay_ms();
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    /// Record a tentative 101 for a forwarded WebSocket upgrade so its row isn't
    /// left forever-pending (a real response overwrites it by the same id).
    fn record_ws_upgrade(&self, id: &str) {
        let captured = CapturedResponse {
            status: 101,
            version: "HTTP/1.1".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            timestamp_ms: now_ms(),
        };
        self.shared.record_complete(id, captured, 0, Some(0), None);
    }

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

/// Resolve the routing-target host: prefer the URI authority (the real target
/// for plain-HTTP forward-proxy requests) over the spoofable Host header, so an
/// exclusion/capture filter can't be bypassed by a Host that disagrees with where
/// the request is really sent. Intercepted HTTPS has a relative URI (no
/// authority), so it falls back to the Host header.
fn request_host(uri: &Uri, headers: &HeaderMap) -> String {
    uri.host()
        .map(|s| s.to_string())
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

/// Whether the request is a WebSocket upgrade handshake.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|u| u.to_ascii_lowercase().contains("websocket"))
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

/// A body that emits a buffered `prefix` then surfaces a stream `error`. Used
/// when the upstream errored mid-body: the client sees the bytes received so far
/// then a failed transfer, instead of a silently-truncated "complete" response.
struct PrefixThenError {
    prefix: Option<Bytes>,
    error: Option<Error>,
}

impl HttpBody for PrefixThenError {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let me = self.get_mut();
        if let Some(prefix) = me.prefix.take() {
            return Poll::Ready(Some(Ok(Frame::data(prefix))));
        }
        if let Some(error) = me.error.take() {
            return Poll::Ready(Some(Err(error)));
        }
        Poll::Ready(None)
    }

    fn is_end_stream(&self) -> bool {
        self.prefix.is_none() && self.error.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// Buffer a body for capture, hard-capped at `MAX_CAPTURE_BODY` so an
/// undeclared-length (e.g. chunked) body can't exhaust memory. Returns
/// `(captured_bytes, forward, complete)`:
/// * `captured_bytes` — up to `cap` bytes of the body.
/// * `forward` — `Some` ONLY when the body exceeded the cap (re-emits the prefix
///   then streams the remainder, so the FULL content reaches the wire) or the
///   upstream errored mid-body (re-emits the prefix then the error). `None` when
///   the body fit within the cap and ended cleanly — the caller forwards the
///   captured bytes directly (after any rewrite).
/// * `complete` — `false` when the upstream stream errored mid-body (the capture
///   is a truncated prefix), `true` otherwise.
async fn buffer_capped(body: Body, cap: usize) -> (Vec<u8>, Option<Body>, bool) {
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    buf.extend_from_slice(&data);
                    if buf.len() >= cap {
                        let prefix = Bytes::from(buf.clone());
                        buf.truncate(cap);
                        let forward = Body::from(BoxBody::new(PrefixThenBody {
                            prefix: Some(prefix),
                            inner: body,
                        }));
                        return (buf, Some(forward), true);
                    }
                }
            }
            // Upstream errored mid-body: forward the prefix then propagate the
            // error so the client sees a failed (not falsely-complete) transfer.
            Some(Err(e)) => {
                let prefix = Bytes::from(buf.clone());
                let forward = Body::from(BoxBody::new(PrefixThenError {
                    prefix: Some(prefix),
                    error: Some(e),
                }));
                return (buf, Some(forward), false);
            }
            None => break,
        }
    }
    (buf, None, true)
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
        let (captured, forward, complete) = buffer_capped(Body::from(vec![1u8, 2, 3]), 64).await;
        assert_eq!(captured, vec![1, 2, 3]);
        assert!(forward.is_none(), "body within the cap needs no streaming forward");
        assert!(complete, "a clean small body is complete");
    }

    #[tokio::test]
    async fn buffer_capped_truncates_capture_but_forwards_full_body() {
        let data = vec![b'x'; 100];
        let (captured, forward, complete) = buffer_capped(Body::from(data.clone()), 40).await;
        // Capture is capped...
        assert_eq!(captured.len(), 40);
        assert!(complete, "an over-cap body that streamed cleanly is complete");
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

    /// A body that yields one data frame then a stream error.
    struct ErrAfter {
        data: Option<Bytes>,
        errored: bool,
    }

    impl HttpBody for ErrAfter {
        type Data = Bytes;
        type Error = Error;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            let me = self.get_mut();
            if let Some(d) = me.data.take() {
                return Poll::Ready(Some(Ok(Frame::data(d))));
            }
            if !me.errored {
                me.errored = true;
                return Poll::Ready(Some(Err(Error::from(std::io::Error::other("upstream reset")))));
            }
            Poll::Ready(None)
        }
    }

    #[tokio::test]
    async fn buffer_capped_marks_mid_body_error_incomplete() {
        let body = Body::from(BoxBody::new(ErrAfter {
            data: Some(Bytes::from_static(b"partial")),
            errored: false,
        }));
        let (captured, forward, complete) = buffer_capped(body, 1024).await;
        assert_eq!(captured, b"partial", "the prefix before the error is captured");
        assert!(!complete, "a mid-body error marks the capture incomplete");
        // The forwarded body must surface the error (not end cleanly), so the
        // client sees a failed transfer rather than a falsely-complete response.
        let err = forward
            .expect("an errored body returns a forward that propagates the error")
            .collect()
            .await;
        assert!(err.is_err(), "the forwarded body propagates the upstream error");
    }
}
