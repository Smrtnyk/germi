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
use hudsucker::hyper::{HeaderMap, Method, Request, Response, Uri};
use hudsucker::tokio_tungstenite::tungstenite::Message;
use hudsucker::{
    Body, Error, HttpContext, HttpHandler, RequestOrResponse, WebSocketContext, WebSocketHandler,
};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};
use crate::rules::{RequestOutcome, SyntheticResponse};
use crate::scripting::{Effects, HeaderOp};
use crate::shared::Shared;

/// A body is buffered into memory (to capture it and run rewrite rules) up to
/// this size. Bodies whose declared `Content-Length` exceeds it are forwarded
/// **unbuffered** (streamed through untouched, with only a body-less placeholder
/// captured) so a huge or hostile transfer can't be collected entirely into RAM.
/// Bodies with no declared length are buffered up to this bound and, if they
/// exceed it, the FULL body is still forwarded (capped prefix + remaining stream)
/// while only the prefix is captured — so the wire is never truncated.
pub(crate) const MAX_CAPTURE_BODY: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct CaptureHandler {
    shared: Arc<Shared>,
    inflight: Option<Inflight>,
}

#[derive(Clone)]
struct Inflight {
    id: String,
    start: Instant,
    /// The Map Remote rule that redirected this request, if any — stamped as
    /// the flow's matched rule when the (upstream) response completes.
    rule: Option<String>,
    /// The captured request, carried here rather than re-fetched from the
    /// store: the bounded store may evict the pending flow before its response
    /// arrives, and response-phase rules, scripts and the HEAD/304
    /// Content-Length restore must still see the request. Lives only for the
    /// request's duration, so the clone is cheap relative to the store copy.
    request: CapturedRequest,
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

        // hudsucker routes the CONNECT itself through `handle_request` before it
        // establishes the tunnel. A CONNECT carries no HTTP exchange (its bytes
        // are the encrypted tunnel), `handle_response` never fires for it, and
        // running it through the autoresponder could return a mock as the tunnel
        // response and break TLS. Pass it through untouched — the decrypted
        // requests inside the tunnel are captured on their own `handle_request`.
        if parts.method == Method::CONNECT {
            self.inflight = None;
            return Request::from_parts(parts, body).into();
        }

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
        let (body_bytes, stream_forward): (Bytes, Option<Body>) = if oversized {
            (Bytes::new(), Some(body))
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

        let mut captured = CapturedRequest {
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

        // User scripts run before the autoresponder, so a script may rewrite the
        // request the rules match on (and what's recorded/forwarded).
        self.run_request_scripts(&mut parts.headers, &mut captured);

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

        // Keep a copy of the request (it's about to move into the Flow): mocks
        // never reach handle_response and run their response-phase rules/scripts
        // here, and forwarded requests carry it on the in-flight entry.
        let request = captured.clone();

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
                let out = self.serve_synthetic(&id, &rule, response, &request).await;
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Block { rule, .. } => {
                let synthetic = SyntheticResponse {
                    status: 403,
                    headers: vec![("content-type".to_string(), "text/plain".to_string())],
                    body: Bytes::from_static(b"Blocked by Germi"),
                };
                let out = self.serve_synthetic(&id, &rule, synthetic, &request).await;
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Continue { set_headers } => {
                // Forward the streaming remainder (oversized/truncated) or a body
                // rebuilt from the captured bytes.
                let forward = stream_forward.unwrap_or_else(|| Body::from(body_bytes));
                let inflight = Inflight { id, start, rule: None, request };
                self.forward_upstream(inflight, None, parts, &set_headers, forward)
            }
            // Map Remote: same forwarding as Continue, but pointed at the
            // rule's rewritten URL. The flow keeps the ORIGINAL request (what
            // the client asked for); the rule label lands in "Mocked-by" when
            // the mapped response completes.
            RequestOutcome::MapRemote {
                rule,
                url,
                set_headers,
                ..
            } => {
                let forward = stream_forward.unwrap_or_else(|| Body::from(body_bytes));
                let inflight = Inflight { id, start, rule: Some(rule), request };
                self.forward_upstream(inflight, Some(url), parts, &set_headers, forward)
            }
        }
    }

    async fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> Response<Body> {
        self.process_response(res).await
    }

    /// Decide whether to MITM a CONNECT. Bypassed hosts return `false`, so
    /// hudsucker blind-tunnels them (no certificate, decryption, or capture).
    async fn should_intercept(&mut self, _ctx: &HttpContext, req: &Request<Body>) -> bool {
        let host = req.uri().host().unwrap_or_default();
        !self.shared.should_bypass(host)
    }

    /// The upstream request failed (connection refused, DNS failure, upstream
    /// TLS error). `handle_response` never fires, so complete the pending row
    /// with a 502 instead of stranding it forever-"pending", then return the
    /// same bare 502 the client would otherwise get.
    async fn handle_error(
        &mut self,
        _ctx: &HttpContext,
        err: hudsucker::hyper_util::client::legacy::Error,
    ) -> Response<Body> {
        if let Some(inflight) = self.inflight.take() {
            let duration = inflight.start.elapsed().as_millis() as u64;
            let captured = CapturedResponse {
                status: 502,
                version: "HTTP/1.1".to_string(),
                headers: vec![("content-type".to_string(), "text/plain".to_string())],
                body: Bytes::from(format!("Upstream request failed: {err}")),
                timestamp_ms: now_ms(),
            };
            // Keep the Map Remote provenance on the 502 so a dead mapped
            // target is attributable to the rule that pointed there.
            self.shared
                .record_complete(&inflight.id, captured, duration, None, inflight.rule);
        }
        Response::builder()
            .status(502)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()))
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

    /// The body of `handle_response`, split out so tests can drive it directly
    /// (hudsucker's `HttpContext` is non-exhaustive and can't be constructed).
    async fn process_response(&mut self, res: Response<Body>) -> Response<Body> {
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
                body: Bytes::new(),
                timestamp_ms: now_ms(),
            };
            self.shared
                .record_complete(&inflight.id, captured, duration, ttfb, inflight.rule.clone());
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
                .record_complete(&inflight.id, captured, duration, ttfb, inflight.rule.clone());
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
        // Snapshot the display strings before rules/scripts run: the wire rebuild
        // diffs against this to keep untouched headers byte-identical (the
        // strings are lossy — see `build_wire_response`).
        let original_pairs = captured.headers.clone();

        // The in-flight copy — NOT a store lookup: the bounded store may have
        // evicted the pending flow, and response rules / scripts / the
        // Content-Length restore must still see the request.
        let req = &inflight.request;
        let mut matched = None;
        // Lock order autoresponder→cursors matches handle_request, so the two
        // never deadlock; held only for this synchronous rewrite (no .await).
        if let (Ok(ar), Ok(mut cursors)) =
            (self.shared.autoresponder.read(), self.shared.cursors.lock())
        {
            matched = ar.apply_response_stateful(req, &mut captured, &mut cursors);
        }

        // User scripts get the last word on the response the client sees.
        let script_res_effects = match self.shared.scripts.read() {
            Ok(engine) if engine.wants_response() => {
                Some(engine.run_response(Some(req), &captured))
            }
            _ => None,
        };
        if let Some(effects) = script_res_effects {
            apply_response_effects(&mut captured, effects);
        }

        // Rules/scripts may have set an out-of-range status; sanitize before the
        // wire response is built AND before recording, so both stay in agreement.
        captured.status = sanitize_status(captured.status);
        let mut out = build_wire_response(&parts.headers, &original_pairs, &captured);

        // A HEAD response (and a 304) legitimately declares a Content-Length that
        // describes the resource, not the (absent) body. `build_parts` drops it so
        // hyper recomputes the length from the body — which is empty here, giving a
        // wrong `content-length: 0`. Restore the upstream value for these.
        let bodyless =
            parts.status.as_u16() == 304 || req.method.eq_ignore_ascii_case("HEAD");
        if bodyless {
            if let Some(cl) = parts.headers.get(CONTENT_LENGTH) {
                out.headers_mut().insert(CONTENT_LENGTH, cl.clone());
            }
        }

        let duration = inflight.start.elapsed().as_millis() as u64;
        // A Map Remote rule is the flow's provenance even when a response-phase
        // rule also touched the response — mirroring how a mock rule stays the
        // matched rule for synthesized responses.
        let matched = inflight.rule.or(matched);
        self.shared
            .record_complete(&inflight.id, captured, duration, ttfb, matched);

        self.throttle().await;
        out
    }

    /// Record a tentative 101 for a forwarded WebSocket upgrade so its row isn't
    /// left forever-pending (a real response overwrites it by the same id).
    fn record_ws_upgrade(&self, id: &str) {
        let captured = CapturedResponse {
            status: 101,
            version: "HTTP/1.1".to_string(),
            headers: Vec::new(),
            body: Bytes::new(),
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

    /// Run response-phase scripts over a rule-synthesized (mock/block) response so
    /// a mock gets the same treatment (e.g. CORS headers) as a real upstream one —
    /// the second call site that makes the response hook truly global, since mocks
    /// never reach `handle_response`.
    fn run_scripts_on_synthetic(&self, req: &CapturedRequest, synthetic: &mut SyntheticResponse) {
        let Ok(engine) = self.shared.scripts.read() else {
            return;
        };
        if !engine.wants_response() {
            return;
        }
        let mut captured = CapturedResponse {
            status: synthetic.status,
            version: "HTTP/1.1".to_string(),
            headers: std::mem::take(&mut synthetic.headers),
            body: std::mem::take(&mut synthetic.body),
            timestamp_ms: now_ms(),
        };
        let effects = engine.run_response(Some(req), &captured);
        drop(engine);
        apply_response_effects(&mut captured, effects);
        synthetic.status = captured.status;
        synthetic.headers = captured.headers;
        synthetic.body = captured.body;
    }

    /// Run request-phase scripts over `captured`, replaying their header effects
    /// onto the forwarded wire headers and the captured copy.
    fn run_request_scripts(&self, wire: &mut HeaderMap, captured: &mut CapturedRequest) {
        let effects = match self.shared.scripts.read() {
            Ok(engine) if engine.wants_request() => engine.run_request(captured),
            _ => return,
        };
        apply_request_effects(wire, &mut captured.headers, effects);
    }

    /// Run response-phase rules over a rule-synthesized response, mirroring the
    /// passthrough path — synthesized responses never reach `handle_response`, so
    /// without this a `setResponseHeader` / `setStatus` / CORS rule would silently
    /// skip every mocked response. Runs before scripts (same order as
    /// `handle_response`: rules first, scripts get the last word).
    fn run_rules_on_synthetic(&self, req: &CapturedRequest, synthetic: &mut SyntheticResponse) {
        let mut captured = CapturedResponse {
            status: synthetic.status,
            version: "HTTP/1.1".to_string(),
            headers: std::mem::take(&mut synthetic.headers),
            body: std::mem::take(&mut synthetic.body),
            timestamp_ms: now_ms(),
        };
        // Lock order autoresponder→cursors matches handle_request, so the two
        // never deadlock; held only for this synchronous rewrite (no .await).
        if let (Ok(ar), Ok(mut cursors)) =
            (self.shared.autoresponder.read(), self.shared.cursors.lock())
        {
            ar.apply_response_stateful(req, &mut captured, &mut cursors);
        }
        synthetic.status = captured.status;
        synthetic.headers = captured.headers;
        synthetic.body = captured.body;
    }

    /// Forward a request upstream (the Continue and Map Remote paths): stash the
    /// in-flight entry, apply rule header edits, repoint at a Map Remote target
    /// when `target` carries one, and record a tentative 101 for a WebSocket
    /// upgrade — a successful upgrade hands the connection to the WS handler
    /// and `handle_response` never fires, which would strand a forever-"pending"
    /// row (a real response, e.g. a rejected upgrade, overwrites it by id).
    fn forward_upstream(
        &mut self,
        inflight: Inflight,
        target: Option<String>,
        mut parts: hudsucker::hyper::http::request::Parts,
        set_headers: &[(String, String)],
        body: Body,
    ) -> RequestOrResponse {
        apply_set_headers(&mut parts.headers, set_headers);
        if let Some(target) = target {
            remap_request_target(&mut parts, &target);
        }
        if is_websocket_upgrade(&parts.headers) {
            self.record_ws_upgrade(&inflight.id);
        }
        self.inflight = Some(inflight);
        Request::from_parts(parts, body).into()
    }

    /// Finalize a rule-synthesized response: run response-phase rules then scripts
    /// over it, record it, and build the wire response the client receives —
    /// after the response-delay throttle, so a configured delay simulates a slow
    /// backend even when the response never left the proxy.
    async fn serve_synthetic(
        &self,
        id: &str,
        rule: &str,
        mut response: SyntheticResponse,
        req: &CapturedRequest,
    ) -> Response<Body> {
        self.run_rules_on_synthetic(req, &mut response);
        self.run_scripts_on_synthetic(req, &mut response);
        // Sanitize the (rule/script-supplied) status before the wire response is
        // built AND before recording, so both stay in agreement.
        response.status = sanitize_status(response.status);
        let out = build_response(&response);
        self.complete_synthetic(id, rule, response);
        self.throttle().await;
        out
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
async fn buffer_capped(body: Body, cap: usize) -> (Bytes, Option<Body>, bool) {
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    buf.extend_from_slice(&data);
                    if buf.len() >= cap {
                        let prefix = Bytes::from(buf);
                        let captured = prefix.slice(..cap);
                        let forward = Body::from(BoxBody::new(PrefixThenBody {
                            prefix: Some(prefix),
                            inner: body,
                        }));
                        return (captured, Some(forward), true);
                    }
                }
            }
            // Upstream errored mid-body: forward the prefix then propagate the
            // error so the client sees a failed (not falsely-complete) transfer.
            Some(Err(e)) => {
                let prefix = Bytes::from(buf);
                let forward = Body::from(BoxBody::new(PrefixThenError {
                    prefix: Some(prefix.clone()),
                    error: Some(e),
                }));
                return (prefix, Some(forward), false);
            }
            None => break,
        }
    }
    (Bytes::from(buf), None, true)
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

/// Build the wire response for a buffered upstream exchange. The captured
/// header values are display strings (lossy UTF-8), so rebuilding every header
/// from them would corrupt legal obs-text bytes (e.g. a latin-1 filename in
/// Content-Disposition) even when nothing touched the response. Instead, diff
/// per name (case-insensitive, multi-value aware) against the pre-rules
/// snapshot: an unchanged name keeps its original `HeaderValue` entries
/// byte-for-byte; a changed/added name is built from the new strings; a
/// removed name is dropped. Length/encoding headers are dropped either way so
/// hyper recomputes them from the (possibly rewritten) body.
fn build_wire_response(
    original: &HeaderMap,
    original_pairs: &[(String, String)],
    captured: &CapturedResponse,
) -> Response<Body> {
    let mut builder = Response::builder().status(captured.status);
    let mut seen: Vec<&str> = Vec::new();
    for (name, _) in &captured.headers {
        if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
            || seen.iter().any(|s| s.eq_ignore_ascii_case(name))
        {
            continue;
        }
        seen.push(name);
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        if header_values(&captured.headers, name) == header_values(original_pairs, name) {
            for val in original.get_all(&header_name) {
                builder = builder.header(header_name.clone(), val.clone());
            }
        } else {
            for val in header_values(&captured.headers, name) {
                if let Ok(val) = HeaderValue::from_bytes(val.as_bytes()) {
                    builder = builder.header(header_name.clone(), val);
                }
            }
        }
    }
    builder
        .body(Body::from(captured.body.clone()))
        .unwrap_or_else(|_| Response::new(Body::from(captured.body.clone())))
}

/// The ordered value list a display-header vec holds for `name`.
fn header_values<'a>(pairs: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    pairs
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
        .collect()
}

/// Clamp a rule/script-supplied status to hyper's valid range (100..=999). An
/// out-of-range value poisons `Response::builder`, whose fallback serves 200
/// with EVERY header dropped — while the store would record the configured
/// status, so wire and inspector disagree. Falling back to 200 here, before the
/// response is built or recorded, keeps the headers and keeps them in sync.
fn sanitize_status(status: u16) -> u16 {
    if (100..=999).contains(&status) {
        status
    } else {
        200
    }
}

fn build_parts(status: u16, headers: &[(String, String)], body: &Bytes) -> Response<Body> {
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
        .body(Body::from(body.clone()))
        .unwrap_or_else(|_| Response::new(Body::from(body.clone())))
}

/// Replay a script's header effects onto both the forwarded request (`wire`, a
/// `HeaderMap`) and the captured copy (`captured`, the recorded `Vec`), so the
/// edits reach upstream AND show in the inspector. `Effects::status` is ignored
/// for requests.
fn apply_request_effects(
    wire: &mut HeaderMap,
    captured: &mut Vec<(String, String)>,
    effects: Effects,
) {
    for op in effects.header_ops {
        match op {
            HeaderOp::Set(name, value) => {
                remove_header_ci(captured, &name);
                captured.push((name.clone(), value.clone()));
                if let (Ok(n), Ok(v)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                ) {
                    wire.insert(n, v);
                }
            }
            HeaderOp::Add(name, value) => {
                captured.push((name.clone(), value.clone()));
                if let (Ok(n), Ok(v)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                ) {
                    wire.append(n, v);
                }
            }
            HeaderOp::Remove(name) => {
                remove_header_ci(captured, &name);
                if let Ok(n) = HeaderName::from_bytes(name.as_bytes()) {
                    wire.remove(&n);
                }
            }
        }
    }
}

/// Replay a script's header/status effects onto a captured response. The wire
/// response is rebuilt from this by `build_wire_response`, so mutating the
/// captured copy is enough.
fn apply_response_effects(captured: &mut CapturedResponse, effects: Effects) {
    for op in effects.header_ops {
        match op {
            HeaderOp::Set(name, value) => {
                remove_header_ci(&mut captured.headers, &name);
                captured.headers.push((name, value));
            }
            HeaderOp::Add(name, value) => captured.headers.push((name, value)),
            HeaderOp::Remove(name) => remove_header_ci(&mut captured.headers, &name),
        }
    }
    if let Some(status) = effects.status {
        captured.status = status;
    }
}

fn remove_header_ci(headers: &mut Vec<(String, String)>, name: &str) {
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
}

/// Point a request at a Map Remote target: swap in the rewritten absolute URI
/// and update the Host header to the new authority. hudsucker strips Host
/// before forwarding (hyper regenerates it from the URI), but the WebSocket
/// upgrade path doesn't — rewriting it here keeps both consistent. The target
/// was already validated by the rules engine; an unparseable one leaves the
/// request untouched rather than breaking the flow.
fn remap_request_target(parts: &mut hudsucker::hyper::http::request::Parts, target: &str) {
    let Ok(uri) = target.parse::<Uri>() else {
        return;
    };
    if let Some(host) = uri
        .authority()
        .and_then(|a| HeaderValue::from_str(a.as_str()).ok())
    {
        parts.headers.insert(HOST, host);
    }
    parts.uri = uri;
}

/// Apply rule-supplied `set_headers` (a request-phase rewrite) to the wire request.
fn apply_set_headers(headers: &mut HeaderMap, set_headers: &[(String, String)]) {
    for (k, v) in set_headers {
        if let (Ok(name), Ok(val)) =
            (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v))
        {
            headers.insert(name, val);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[test]
    fn apply_response_effects_sets_replaces_adds_removes_and_status() {
        let mut captured = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![
                ("content-type".into(), "text/html".into()),
                ("x-drop".into(), "1".into()),
            ],
            body: Bytes::new(),
            timestamp_ms: 0,
        };
        let effects = Effects {
            header_ops: vec![
                HeaderOp::Set("Content-Type".into(), "application/json".into()),
                HeaderOp::Add("set-cookie".into(), "a=1".into()),
                HeaderOp::Remove("X-Drop".into()),
            ],
            status: Some(201),
        };
        apply_response_effects(&mut captured, effects);
        assert_eq!(captured.status, 201);
        // Set replaced the existing header (case-insensitively), not duplicated it.
        let content_types: Vec<_> = captured
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .collect();
        assert_eq!(content_types.len(), 1);
        assert_eq!(content_types[0].1, "application/json");
        assert!(captured.headers.iter().any(|(k, v)| k == "set-cookie" && v == "a=1"));
        assert!(!captured.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("x-drop")));
    }

    #[test]
    fn apply_request_effects_mutates_wire_and_capture_together() {
        let mut wire = HeaderMap::new();
        wire.insert(HeaderName::from_static("x-old"), HeaderValue::from_static("1"));
        let mut captured = vec![("x-old".to_string(), "1".to_string())];
        let effects = Effects {
            header_ops: vec![
                HeaderOp::Set("x-new".into(), "2".into()),
                HeaderOp::Remove("x-old".into()),
            ],
            // status is meaningless for requests and must be ignored here.
            status: Some(500),
        };
        apply_request_effects(&mut wire, &mut captured, effects);
        assert_eq!(wire.get("x-new").and_then(|v| v.to_str().ok()), Some("2"));
        assert!(wire.get("x-old").is_none());
        assert!(captured.iter().any(|(k, v)| k == "x-new" && v == "2"));
        assert!(!captured.iter().any(|(k, _)| k == "x-old"));
    }

    #[test]
    fn remap_request_target_rewrites_uri_and_host() {
        let (mut parts, ()) = Request::builder()
            .uri("https://cdn.example.com/agent_abc_123.js")
            .header(HOST, "cdn.example.com")
            .body(())
            .expect("request")
            .into_parts();
        remap_request_target(&mut parts, "http://localhost:8080/ajax/agent_abc_1.js");
        assert_eq!(parts.uri.to_string(), "http://localhost:8080/ajax/agent_abc_1.js");
        assert_eq!(
            parts.headers.get(HOST).and_then(|v| v.to_str().ok()),
            Some("localhost:8080")
        );
    }

    #[test]
    fn remap_request_target_ignores_unparseable_target() {
        let (mut parts, ()) = Request::builder()
            .uri("https://cdn.example.com/x")
            .body(())
            .expect("request")
            .into_parts();
        remap_request_target(&mut parts, "http://exa mple/x");
        assert_eq!(parts.uri.to_string(), "https://cdn.example.com/x");
    }

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

    fn test_request() -> CapturedRequest {
        CapturedRequest {
            method: "GET".to_string(),
            uri: "https://example.com/api".to_string(),
            scheme: "https".to_string(),
            host: "example.com".to_string(),
            path: "/api".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![],
            body: bytes::Bytes::new(),
            timestamp_ms: 0,
        }
    }

    fn pending_flow(id: &str) -> Flow {
        Flow {
            id: id.to_string(),
            seq: 0,
            request: test_request(),
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        }
    }

    fn test_shared(max_flows: usize) -> Arc<Shared> {
        shared_with_responder(max_flows, crate::rules::AutoResponder::default())
    }

    fn shared_with_responder(
        max_flows: usize,
        responder: crate::rules::AutoResponder,
    ) -> Arc<Shared> {
        Shared::new(max_flows, responder, crate::settings::ProxySettings::default())
    }

    fn responder_with(action: crate::rules::Action) -> crate::rules::AutoResponder {
        let mut ar = crate::rules::AutoResponder::default();
        ar.ensure_general();
        ar.scenarios.push(crate::rules::Scenario {
            id: "s".to_string(),
            name: "s".to_string(),
            rules: vec![crate::rules::Rule {
                id: "r".to_string(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: crate::rules::Matcher {
                    method: None,
                    url: "/".to_string(),
                    url_match: crate::rules::MatchKind::Contains,
                },
                action,
            }],
        });
        ar.active_scenario_id = Some("s".to_string());
        ar
    }

    fn inflight_for(id: &str, request: CapturedRequest) -> Inflight {
        Inflight {
            id: id.to_string(),
            start: Instant::now(),
            rule: None,
            request,
        }
    }

    #[tokio::test]
    async fn response_rules_use_the_inflight_request_after_eviction() {
        let shared = shared_with_responder(
            1,
            responder_with(crate::rules::Action::SetResponseHeader {
                name: "x-rule".to_string(),
                value: "on".to_string(),
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        // Cap 1: a second pending capture evicts "f1" before its response arrives.
        shared.record_new(pending_flow("f2"));
        assert!(shared.store.lock().unwrap().get("f1").is_none(), "f1 must be evicted");

        let res = Response::builder().status(200).body(Body::from("hi")).expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.headers().get("x-rule").and_then(|v| v.to_str().ok()),
            Some("on"),
            "response-phase rules must still apply to an evicted flow's response"
        );
    }

    #[tokio::test]
    async fn head_content_length_restore_survives_eviction() {
        let shared = test_shared(1);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        let mut req = test_request();
        req.method = "HEAD".to_string();
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", req));
        shared.record_new(pending_flow("f2"));

        let res = Response::builder()
            .status(200)
            .header(CONTENT_LENGTH, "5000")
            .body(Body::empty())
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()),
            Some("5000"),
            "HEAD's resource Content-Length must be restored even after eviction"
        );
    }

    #[tokio::test]
    async fn invalid_set_status_falls_back_to_200_keeping_headers() {
        let shared =
            shared_with_responder(10, responder_with(crate::rules::Action::SetStatus {
                status: 1000,
            }));
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));

        let res = Response::builder()
            .status(200)
            .header("x-upstream", "1")
            .body(Body::from("hi"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(out.status().as_u16(), 200, "an out-of-range SetStatus falls back to 200");
        assert_eq!(
            out.headers().get("x-upstream").and_then(|v| v.to_str().ok()),
            Some("1"),
            "upstream headers must survive an invalid SetStatus"
        );
        let recorded = shared
            .store
            .lock()
            .unwrap()
            .get("f1")
            .and_then(|f| f.response.clone())
            .expect("recorded response");
        assert_eq!(
            recorded.status,
            out.status().as_u16(),
            "the store must record the status that actually went on the wire"
        );
    }

    #[tokio::test]
    async fn invalid_mock_status_keeps_headers_and_store_matches_wire() {
        let shared = test_shared(10);
        let handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        let req = test_request();
        let synthetic = SyntheticResponse {
            status: 99,
            headers: vec![
                ("x-mock".to_string(), "1".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
            ],
            body: b"{}".to_vec().into(),
        };
        let out = handler.serve_synthetic("f1", "rule", synthetic, &req).await;
        assert_eq!(
            out.headers().get("x-mock").and_then(|v| v.to_str().ok()),
            Some("1"),
            "configured headers must survive an invalid status"
        );
        assert_eq!(
            out.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json"),
            "the dedicated content-type must survive an invalid status"
        );
        let recorded = shared
            .store
            .lock()
            .unwrap()
            .get("f1")
            .and_then(|f| f.response.clone())
            .expect("recorded response");
        assert_eq!(
            recorded.status,
            out.status().as_u16(),
            "the store must record the status that actually went on the wire"
        );
    }

    #[tokio::test]
    async fn mock_response_waits_for_the_configured_delay() {
        let shared = Shared::new(
            10,
            crate::rules::AutoResponder::default(),
            crate::settings::ProxySettings { response_delay_ms: 60, ..Default::default() },
        );
        let handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        let synthetic = SyntheticResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"mock".to_vec().into(),
        };
        let start = Instant::now();
        let _ = handler.serve_synthetic("f1", "rule", synthetic, &test_request()).await;
        assert!(
            start.elapsed() >= Duration::from_millis(60),
            "a mocked response must honor the response-delay throttle"
        );
    }

    #[tokio::test]
    async fn mock_response_without_delay_stays_fast() {
        let shared = test_shared(10);
        let handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        let synthetic = SyntheticResponse {
            status: 200,
            headers: vec![],
            body: b"mock".to_vec().into(),
        };
        let start = Instant::now();
        let _ = handler.serve_synthetic("f1", "rule", synthetic, &test_request()).await;
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "the default zero delay must not slow the mock path down"
        );
    }

    const LATIN1_DISPOSITION: &[u8] = b"attachment; filename=\"caf\xE9.pdf\"";

    fn obs_text_response() -> Response<Body> {
        Response::builder()
            .status(200)
            .header(
                "content-disposition",
                HeaderValue::from_bytes(LATIN1_DISPOSITION).expect("obs-text value"),
            )
            .body(Body::from("hi"))
            .expect("response")
    }

    #[tokio::test]
    async fn untouched_obs_text_header_is_forwarded_byte_identical() {
        let shared = test_shared(10);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let out = handler.process_response(obs_text_response()).await;
        assert_eq!(
            out.headers().get("content-disposition").map(HeaderValue::as_bytes),
            Some(LATIN1_DISPOSITION),
            "untouched obs-text header bytes must never degrade on the wire"
        );
    }

    #[tokio::test]
    async fn rule_setting_an_unrelated_header_keeps_obs_text_bytes() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetResponseHeader {
                name: "x-rule".to_string(),
                value: "on".to_string(),
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let out = handler.process_response(obs_text_response()).await;
        assert_eq!(
            out.headers().get("x-rule").and_then(|v| v.to_str().ok()),
            Some("on"),
            "the rule's header must land on the wire"
        );
        assert_eq!(
            out.headers().get("content-disposition").map(HeaderValue::as_bytes),
            Some(LATIN1_DISPOSITION),
            "an unrelated rule edit must not degrade obs-text bytes elsewhere"
        );
    }

    #[tokio::test]
    async fn rule_rewriting_the_obs_text_header_wins() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetResponseHeader {
                name: "content-disposition".to_string(),
                value: "inline".to_string(),
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let out = handler.process_response(obs_text_response()).await;
        assert_eq!(
            out.headers().get("content-disposition").map(HeaderValue::as_bytes),
            Some(b"inline".as_slice()),
            "a rule that rewrites the header must win with its new value"
        );
    }

    #[tokio::test]
    async fn buffer_capped_marks_mid_body_error_incomplete() {
        let body = Body::from(BoxBody::new(ErrAfter {
            data: Some(Bytes::from_static(b"partial")),
            errored: false,
        }));
        let (captured, forward, complete) = buffer_capped(body, 1024).await;
        assert_eq!(captured, b"partial".as_slice(), "the prefix before the error is captured");
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
