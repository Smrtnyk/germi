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
use hudsucker::hyper::header::{
    HeaderName, HeaderValue, CONTENT_LENGTH, HOST, TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use hudsucker::hyper::{HeaderMap, Method, Request, Response, Uri};
use hudsucker::tokio_tungstenite::tungstenite::Message;
use hudsucker::{
    Body, Error, HttpContext, HttpHandler, RequestOrResponse, WebSocketContext, WebSocketHandler,
};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};
use crate::http_semantics::{
    is_framing_header, response_has_no_body, sanitize_status, status_forbids_body,
};
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
    /// False when the captured request holds only an empty/truncated prefix.
    /// Response scripts may still inspect request metadata, but reading
    /// `req.body` must fail rather than masquerade as a complete body.
    request_body_complete: bool,
}

struct PreparedRequest {
    parts: hudsucker::hyper::http::request::Parts,
    body_bytes: Bytes,
    stream_forward: Option<Body>,
    original_headers: HeaderMap,
    preserve_trailers: bool,
    id: String,
    start: Instant,
    request: CapturedRequest,
    request_body_complete: bool,
}

struct UpstreamRequest {
    target: Option<String>,
    parts: hudsucker::hyper::http::request::Parts,
    set_headers: Vec<(String, String)>,
    body: Body,
    original_headers: HeaderMap,
    preserve_trailers: bool,
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

        let (body_bytes, stream_forward, request_body_complete) =
            capture_request_body(&parts.headers, body).await;
        let mut captured = captured_request(&parts, host, body_bytes.clone());
        let original_request_headers = parts.headers.clone();
        let original_request_pairs = captured.headers.clone();

        // User scripts run before the autoresponder, so a script may rewrite the
        // request the rules match on (and what's recorded/forwarded).
        self.run_request_scripts(&mut parts.headers, &mut captured, request_body_complete);

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

        let forwards_upstream = matches!(
            &outcome,
            RequestOutcome::Continue { .. } | RequestOutcome::MapRemote { .. }
        );
        let set_headers = match &outcome {
            RequestOutcome::Continue { set_headers }
            | RequestOutcome::Respond { set_headers, .. }
            | RequestOutcome::Block { set_headers, .. }
            | RequestOutcome::MapRemote { set_headers, .. } => set_headers,
        };
        if !set_headers.is_empty() {
            // Rule edits are part of the effective request just like script
            // edits. Keep the inspector and downstream response rules/scripts
            // in sync with the effective request, including when a later rule
            // short-circuits. A Map Remote URL itself intentionally remains the
            // client's URL in the captured copy.
            apply_set_header_pairs(&mut captured.headers, set_headers);
        }
        let preserves_trailers = stream_forward.is_some();
        if forwards_upstream {
            // Request scripts/rules only edit metadata; they never replace the
            // body. Letting them alter framing around unchanged (especially
            // streamed) bytes can truncate an upload or make upstream wait
            // forever. A fully-buffered rebuild has already consumed trailers,
            // so do not keep advertising trailers that can no longer be sent.
            restore_message_framing(
                &mut captured.headers,
                &original_request_pairs,
                preserves_trailers,
            );
        }

        let id = self.shared.next_id();
        let start = Instant::now();

        // Keep a copy of the request (it's about to move into the Flow): mocks
        // never reach handle_response and run their response-phase rules/scripts
        // here, and forwarded requests carry it on the in-flight entry.
        let request = captured.clone();

        // Emit the request immediately (response pending).
        self.shared.record_captured(Flow {
            id: id.clone(),
            seq: 0,
            request: captured,
            response: None,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: false,
        });

        self.dispatch_request(
            outcome,
            PreparedRequest {
                parts,
                body_bytes,
                stream_forward,
                original_headers: original_request_headers,
                preserve_trailers: preserves_trailers,
                id,
                start,
                request,
                request_body_complete,
            },
        )
        .await
    }

    async fn handle_response(&mut self, _ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
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
    async fn dispatch_request(
        &mut self,
        outcome: RequestOutcome,
        prepared: PreparedRequest,
    ) -> RequestOrResponse {
        let PreparedRequest {
            parts,
            body_bytes,
            stream_forward,
            original_headers,
            preserve_trailers,
            id,
            start,
            request,
            request_body_complete,
        } = prepared;

        match outcome {
            RequestOutcome::Respond { rule, response, .. } => {
                let out = self
                    .serve_synthetic(&id, &rule, response, &request, request_body_complete)
                    .await;
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Block { rule, .. } => {
                let synthetic = SyntheticResponse {
                    status: 403,
                    headers: vec![("content-type".to_string(), "text/plain".to_string())],
                    body: Bytes::from_static(b"Blocked by Germi"),
                };
                let out = self
                    .serve_synthetic(&id, &rule, synthetic, &request, request_body_complete)
                    .await;
                self.inflight = None;
                out.into()
            }
            RequestOutcome::Continue { set_headers } => {
                // Forward the streaming remainder (oversized/truncated) or a body
                // rebuilt from the captured bytes.
                let forward = stream_forward.unwrap_or_else(|| Body::from(body_bytes));
                let inflight = Inflight {
                    id,
                    start,
                    rule: None,
                    request,
                    request_body_complete,
                };
                self.forward_upstream(
                    inflight,
                    UpstreamRequest {
                        target: None,
                        parts,
                        set_headers,
                        body: forward,
                        original_headers,
                        preserve_trailers,
                    },
                )
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
                let inflight = Inflight {
                    id,
                    start,
                    rule: Some(rule),
                    request,
                    request_body_complete,
                };
                self.forward_upstream(
                    inflight,
                    UpstreamRequest {
                        target: Some(url),
                        parts,
                        set_headers,
                        body: forward,
                        original_headers,
                        preserve_trailers,
                    },
                )
            }
        }
    }
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
            let captured = CapturedResponse {
                status: parts.status.as_u16(),
                version: format!("{:?}", parts.version),
                headers: header_pairs(&parts.headers),
                body: Bytes::new(),
                timestamp_ms: now_ms(),
            };
            return self
                .finish_streaming_response(parts, body, captured, inflight, ttfb)
                .await;
        }

        let (body_bytes, stream_forward, _complete) =
            buffer_capped(body, MAX_CAPTURE_BODY as usize).await;

        // Body exceeded the cap, or the upstream stream errored mid-body: too
        // large / incomplete to safely rewrite. Capture the prefix and forward
        // the body as-is — the remaining stream (prefix + rest), or the prefix
        // then a propagated error so a truncated transfer is never presented to
        // the client as a clean, complete response — with the ORIGINAL headers.
        if let Some(forward) = stream_forward {
            let captured = CapturedResponse {
                status: parts.status.as_u16(),
                version: format!("{:?}", parts.version),
                headers: header_pairs(&parts.headers),
                body: body_bytes,
                timestamp_ms: now_ms(),
            };
            return self
                .finish_streaming_response(parts, forward, captured, inflight, ttfb)
                .await;
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
        let matched =
            self.apply_response_mutations(req, &mut captured, true, inflight.request_body_complete);

        // Rules/scripts may have set an out-of-range status; sanitize before the
        // wire response is built AND before recording, so both stay in agreement.
        captured.status = sanitize_status(captured.status);
        let representation_len = captured.body.len();
        let bodyless = response_has_no_body(&req.method, captured.status);
        if bodyless {
            captured.body = Bytes::new();
        }
        let resource_length = resource_content_length(
            &parts.headers,
            &req.method,
            parts.status.as_u16(),
            captured.status,
            Some(representation_len),
        );
        let content_length = if bodyless {
            normalize_bodyless_framing(&mut captured.headers, resource_length.as_ref());
            resource_length
        } else {
            // `buffer_capped` consumes trailer frames while collecting the body;
            // the rebuilt body cannot emit them. It also has a known final size,
            // so replace any now-stale upstream/script framing in both the wire
            // response and inspector record.
            Some(normalize_buffered_framing(
                &mut captured.headers,
                representation_len,
            ))
        };
        let mut out = build_wire_response(&parts.headers, &original_pairs, &captured);

        if let Some(length) = content_length {
            out.headers_mut().insert(CONTENT_LENGTH, length);
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

    /// Finish a response whose body cannot be fully buffered. Header/status/CORS
    /// rules and scripts remain safe and useful; body rewrites are deliberately
    /// skipped, and the original stream/framing is preserved unless the final
    /// status forbids a body.
    async fn finish_streaming_response(
        &self,
        parts: hudsucker::hyper::http::response::Parts,
        forward: Body,
        mut captured: CapturedResponse,
        inflight: Inflight,
        ttfb: Option<u64>,
    ) -> Response<Body> {
        let original_status = parts.status.as_u16();
        let original_pairs = captured.headers.clone();
        let matched = self.apply_response_mutations(
            &inflight.request,
            &mut captured,
            false,
            inflight.request_body_complete,
        );
        captured.status = sanitize_status(captured.status);

        let bodyless = response_has_no_body(&inflight.request.method, captured.status);
        if bodyless {
            captured.body = Bytes::new();
        }
        let preserve_framing = !bodyless && !status_forbids_body(original_status);
        if preserve_framing {
            // The bytes still come from the untouched upstream stream. A
            // metadata rule/script may edit Content-Length or Transfer-Encoding,
            // but applying that edit to an unchanged stream can truncate the
            // response or leave the client waiting forever. Keep the upstream
            // framing on both the wire and the recorded response.
            restore_message_framing(&mut captured.headers, &original_pairs, true);
        } else if !bodyless {
            // A response that originally forbade a body (304/204/1xx) may be
            // changed to a body-allowed status by a metadata rule. Its original
            // framing no longer describes the forwarded message, and the wire
            // builder drops it below; drop it from the inspector copy too.
            captured
                .headers
                .retain(|(name, _)| !is_framing_header(name));
        }
        let resource_length = resource_content_length(
            &parts.headers,
            &inflight.request.method,
            original_status,
            captured.status,
            None,
        );
        if bodyless {
            normalize_bodyless_framing(&mut captured.headers, resource_length.as_ref());
        }
        let body = if bodyless { Body::empty() } else { forward };
        let mut out = build_wire_response_with_body(
            &parts.headers,
            &original_pairs,
            &captured,
            body,
            preserve_framing,
        );
        if let Some(length) = resource_length {
            out.headers_mut().insert(CONTENT_LENGTH, length);
        }

        let duration = inflight.start.elapsed().as_millis() as u64;
        self.shared.record_complete(
            &inflight.id,
            captured,
            duration,
            ttfb,
            inflight.rule.or(matched),
        );
        self.throttle().await;
        out
    }

    fn apply_response_mutations(
        &self,
        req: &CapturedRequest,
        captured: &mut CapturedResponse,
        allow_body_rewrite: bool,
        request_body_complete: bool,
    ) -> Option<String> {
        let matched = if let (Ok(ar), Ok(mut cursors)) =
            (self.shared.autoresponder.read(), self.shared.cursors.lock())
        {
            ar.apply_response_stateful_mode(req, captured, &mut cursors, allow_body_rewrite)
        } else {
            None
        };

        let effects = match self.shared.scripts.read() {
            Ok(engine) if engine.wants_response() => Some(engine.run_response_with_body_state(
                Some(req),
                captured,
                request_body_complete,
                allow_body_rewrite,
            )),
            _ => None,
        };
        if let Some(effects) = effects {
            apply_response_effects(captured, effects);
        }
        matched
    }

    /// Record a tentative 101 for a forwarded WebSocket upgrade so its row isn't
    /// left forever-pending (a real response overwrites it by the same id).
    fn record_ws_upgrade(&self, id: &str, matched_rule: Option<String>) {
        let captured = CapturedResponse {
            status: 101,
            version: "HTTP/1.1".to_string(),
            headers: Vec::new(),
            body: Bytes::new(),
            timestamp_ms: now_ms(),
        };
        self.shared
            .record_complete(id, captured, 0, Some(0), matched_rule);
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
    fn run_scripts_on_synthetic(
        &self,
        req: &CapturedRequest,
        synthetic: &mut SyntheticResponse,
        request_body_complete: bool,
    ) {
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
        let effects =
            engine.run_response_with_body_state(Some(req), &captured, request_body_complete, true);
        drop(engine);
        apply_response_effects(&mut captured, effects);
        synthetic.status = captured.status;
        synthetic.headers = captured.headers;
        synthetic.body = captured.body;
    }

    /// Run request-phase scripts over `captured`, replaying their header effects
    /// onto the forwarded wire headers and the captured copy.
    fn run_request_scripts(
        &self,
        wire: &mut HeaderMap,
        captured: &mut CapturedRequest,
        body_complete: bool,
    ) {
        let effects = match self.shared.scripts.read() {
            Ok(engine) if engine.wants_request() => {
                engine.run_request_with_body_state(captured, body_complete)
            }
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
        upstream: UpstreamRequest,
    ) -> RequestOrResponse {
        let UpstreamRequest {
            target,
            mut parts,
            set_headers,
            body,
            original_headers,
            preserve_trailers,
        } = upstream;
        apply_set_headers(&mut parts.headers, &set_headers);
        restore_wire_framing(&mut parts.headers, &original_headers, preserve_trailers);
        if let Some(target) = target {
            remap_request_target(&mut parts, &target);
        }
        if is_websocket_upgrade(&parts.headers) {
            self.record_ws_upgrade(&inflight.id, inflight.rule.clone());
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
        request_body_complete: bool,
    ) -> Response<Body> {
        self.run_rules_on_synthetic(req, &mut response);
        self.run_scripts_on_synthetic(req, &mut response, request_body_complete);
        // Sanitize the (rule/script-supplied) status before the wire response is
        // built AND before recording, so both stay in agreement.
        response.status = sanitize_status(response.status);
        response.headers.retain(|(name, value)| {
            HeaderName::from_bytes(name.as_bytes()).is_ok()
                && HeaderValue::from_bytes(value.as_bytes()).is_ok()
        });
        let representation_len = response.body.len();
        let bodyless = response_has_no_body(&req.method, response.status);
        if bodyless {
            response.body = Bytes::new();
        }
        let resource_length = (response.status == 304
            || (req.method.eq_ignore_ascii_case("HEAD")
                && !status_forbids_metadata(response.status)))
        .then(|| HeaderValue::from_str(&representation_len.to_string()).ok())
        .flatten();
        let content_length = if bodyless {
            normalize_bodyless_framing(&mut response.headers, resource_length.as_ref());
            resource_length
        } else {
            // Synthetic bodies have a fixed known size and no trailer-frame API.
            Some(normalize_buffered_framing(
                &mut response.headers,
                representation_len,
            ))
        };
        let mut out = build_response(&response);
        if let Some(length) = content_length {
            out.headers_mut().insert(CONTENT_LENGTH, length);
        }
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
    uri.authority()
        .map(|authority| authority.as_str().to_string())
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
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|protocol| protocol.trim().eq_ignore_ascii_case("websocket"))
        })
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

/// Capture a request body when it is safe to buffer. Declared-large and
/// unexpectedly over-cap bodies are still forwarded in full, but are marked
/// incomplete so scripts cannot mistake an empty/truncated capture for the
/// complete request content.
async fn capture_request_body(headers: &HeaderMap, body: Body) -> (Bytes, Option<Body>, bool) {
    if declared_len(headers).is_some_and(|length| length > MAX_CAPTURE_BODY) {
        return (Bytes::new(), Some(body), false);
    }
    let (bytes, forward, stream_complete) = buffer_capped(body, MAX_CAPTURE_BODY as usize).await;
    let body_complete = stream_complete && forward.is_none();
    (bytes, forward, body_complete)
}

fn captured_request(
    parts: &hudsucker::hyper::http::request::Parts,
    host: String,
    body: Bytes,
) -> CapturedRequest {
    let scheme = parts
        .uri
        .scheme_str()
        .unwrap_or("https") // intercepted CONNECT traffic is https
        .to_string();
    let path = parts.uri.path_and_query().map_or_else(
        || parts.uri.path().to_string(),
        |value| value.as_str().to_string(),
    );
    // Plain HTTP proxy requests normally arrive in absolute form, while a
    // decrypted HTTPS request arrives in origin form (`/path?query`). Keep the
    // captured model consistent and self-contained in both cases: HAR export,
    // scripts' `req.url`, and other consumers all require an absolute URL.
    let uri = if parts.uri.scheme().is_some() && parts.uri.authority().is_some() {
        parts.uri.to_string()
    } else {
        format!("{scheme}://{host}{path}")
    };
    CapturedRequest {
        method: parts.method.as_str().to_string(),
        uri,
        scheme,
        host,
        path,
        version: format!("{:?}", parts.version),
        headers: header_pairs(&parts.headers),
        body,
        timestamp_ms: now_ms(),
    }
}

fn status_forbids_metadata(status: u16) -> bool {
    (100..200).contains(&status) || matches!(status, 204 | 205)
}

/// HEAD and 304 may carry the selected representation's length despite having
/// no wire body. Prefer the upstream declaration when it already described a
/// bodyless response; otherwise use the fully-mutated buffered body's length.
fn resource_content_length(
    original_headers: &HeaderMap,
    method: &str,
    original_status: u16,
    final_status: u16,
    representation_len: Option<usize>,
) -> Option<HeaderValue> {
    let eligible = final_status == 304
        || (method.eq_ignore_ascii_case("HEAD") && !status_forbids_metadata(final_status));
    if !eligible {
        return None;
    }
    if method.eq_ignore_ascii_case("HEAD") || original_status == 304 {
        if let Some(value) = original_headers.get(CONTENT_LENGTH) {
            return Some(value.clone());
        }
    }
    representation_len
        .and_then(|length| HeaderValue::from_str(&length.to_string()).ok())
        .or_else(|| original_headers.get(CONTENT_LENGTH).cloned())
}

/// A body that emits a buffered `prefix` first, then streams the remainder of an
/// inner body. Lets us forward a large body in full (so the wire is never
/// truncated) while having captured only a capped prefix of it.
struct PrefixThenBody {
    prefix: Option<Bytes>,
    overflow: Option<Bytes>,
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
        if let Some(overflow) = me.overflow.take() {
            return Poll::Ready(Some(Ok(Frame::data(overflow))));
        }
        Pin::new(&mut me.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.prefix.is_none() && self.overflow.is_none() && self.inner.is_end_stream()
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
                    let remaining = cap.saturating_sub(buf.len());
                    if data.len() > remaining {
                        // Copy only the bytes the capture can retain. Keep the
                        // rest as a zero-copy Bytes slice for forwarding; a
                        // single hostile frame must not make the capture buffer
                        // grow past `cap` before we notice the overflow.
                        buf.extend_from_slice(&data[..remaining]);
                        let captured = Bytes::from(buf);
                        let overflow = data.slice(remaining..);
                        let forward = Body::from(BoxBody::new(PrefixThenBody {
                            prefix: Some(captured.clone()),
                            overflow: Some(overflow),
                            inner: body,
                        }));
                        return (captured, Some(forward), true);
                    }
                    buf.extend_from_slice(&data);
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
/// removed name is dropped. Framing headers are dropped here and the caller
/// supplies the normalized length for the (possibly rewritten) body.
fn build_wire_response(
    original: &HeaderMap,
    original_pairs: &[(String, String)],
    captured: &CapturedResponse,
) -> Response<Body> {
    build_wire_response_with_body(
        original,
        original_pairs,
        captured,
        Body::from(captured.body.clone()),
        false,
    )
}

fn build_wire_response_with_body(
    original: &HeaderMap,
    original_pairs: &[(String, String)],
    captured: &CapturedResponse,
    body: Body,
    preserve_framing: bool,
) -> Response<Body> {
    let mut out = Response::new(body);
    if let Ok(status) = hudsucker::hyper::StatusCode::from_u16(captured.status) {
        *out.status_mut() = status;
    }
    let mut seen: Vec<&str> = Vec::new();
    for (name, _) in &captured.headers {
        if (!preserve_framing && is_framing_header(name))
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
                out.headers_mut().append(header_name.clone(), val.clone());
            }
        } else {
            append_changed_header_values(
                out.headers_mut(),
                &header_name,
                original,
                &captured.headers,
            );
        }
    }
    out
}

/// Rebuild a changed multi-value header without corrupting untouched obs-text
/// values that remain beside an appended value. Captured header strings are a
/// lossy display projection, so parsing every value back would turn a raw byte
/// such as `0xe9` into UTF-8 replacement bytes. Reuse each matching original
/// value once; genuinely new/replaced values are built from their final text.
fn append_changed_header_values(
    destination: &mut HeaderMap,
    name: &HeaderName,
    original: &HeaderMap,
    captured: &[(String, String)],
) {
    let originals: Vec<&HeaderValue> = original.get_all(name).iter().collect();
    let mut reused = vec![false; originals.len()];
    for value in header_values(captured, name.as_str()) {
        let matching = originals.iter().enumerate().position(|(index, original)| {
            !reused[index] && String::from_utf8_lossy(original.as_bytes()) == value
        });
        if let Some(index) = matching {
            reused[index] = true;
            destination.append(name.clone(), originals[index].clone());
        } else if let Ok(value) = HeaderValue::from_bytes(value.as_bytes()) {
            destination.append(name.clone(), value);
        }
    }
}

/// The ordered value list a display-header vec holds for `name`.
fn header_values<'a>(pairs: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    pairs
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
        .collect()
}

fn build_parts(status: u16, headers: &[(String, String)], body: &Bytes) -> Response<Body> {
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        // Drop caller-supplied framing headers; the caller installs the known
        // body length after building the response, avoiding mismatches.
        if is_framing_header(k) {
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
                let (Ok(n), Ok(v)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                ) else {
                    continue;
                };
                remove_header_ci(captured, &name);
                captured.push((name.clone(), value.clone()));
                wire.insert(n, v);
            }
            HeaderOp::Add(name, value) => {
                let (Ok(n), Ok(v)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                ) else {
                    continue;
                };
                captured.push((name.clone(), value.clone()));
                wire.append(n, v);
            }
            HeaderOp::Remove(name) => {
                let Ok(n) = HeaderName::from_bytes(name.as_bytes()) else {
                    continue;
                };
                remove_header_ci(captured, &name);
                wire.remove(&n);
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
                if HeaderName::from_bytes(name.as_bytes()).is_err()
                    || HeaderValue::from_bytes(value.as_bytes()).is_err()
                {
                    continue;
                }
                remove_header_ci(&mut captured.headers, &name);
                captured.headers.push((name, value));
            }
            HeaderOp::Add(name, value) => {
                if HeaderName::from_bytes(name.as_bytes()).is_ok()
                    && HeaderValue::from_bytes(value.as_bytes()).is_ok()
                {
                    captured.headers.push((name, value));
                }
            }
            HeaderOp::Remove(name) => {
                if HeaderName::from_bytes(name.as_bytes()).is_ok() {
                    remove_header_ci(&mut captured.headers, &name);
                }
            }
        }
    }
    if let Some(status) = effects.status {
        captured.status = status;
    }
}

fn remove_header_ci(headers: &mut Vec<(String, String)>, name: &str) {
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
}

fn restore_message_framing(
    headers: &mut Vec<(String, String)>,
    original: &[(String, String)],
    preserve_trailers: bool,
) {
    headers.retain(|(name, _)| !is_framing_header(name));
    headers.extend(
        original
            .iter()
            .filter(|(name, _)| {
                name.eq_ignore_ascii_case("content-length")
                    || name.eq_ignore_ascii_case("transfer-encoding")
                    || (preserve_trailers && name.eq_ignore_ascii_case("trailer"))
            })
            .cloned(),
    );
}

fn restore_wire_framing(headers: &mut HeaderMap, original: &HeaderMap, preserve_trailers: bool) {
    headers.remove(CONTENT_LENGTH);
    headers.remove(TRANSFER_ENCODING);
    headers.remove(TRAILER);
    for value in original.get_all(CONTENT_LENGTH) {
        headers.append(CONTENT_LENGTH, value.clone());
    }
    for value in original.get_all(TRANSFER_ENCODING) {
        headers.append(TRANSFER_ENCODING, value.clone());
    }
    if preserve_trailers {
        for value in original.get_all(TRAILER) {
            headers.append(TRAILER, value.clone());
        }
    }
}

fn normalize_bodyless_framing(
    headers: &mut Vec<(String, String)>,
    content_length: Option<&HeaderValue>,
) {
    headers.retain(|(name, _)| !is_framing_header(name));
    if let Some(value) = content_length.and_then(|value| value.to_str().ok()) {
        headers.push(("content-length".into(), value.into()));
    }
}

fn normalize_buffered_framing(headers: &mut Vec<(String, String)>, body_len: usize) -> HeaderValue {
    headers.retain(|(name, _)| !is_framing_header(name));
    let text = body_len.to_string();
    let value = HeaderValue::from_str(&text)
        .expect("a decimal usize is always a valid Content-Length header");
    headers.push(("content-length".into(), text));
    value
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
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }
}

fn apply_set_header_pairs(headers: &mut Vec<(String, String)>, set_headers: &[(String, String)]) {
    for (name, value) in set_headers {
        remove_header_ci(headers, name);
        headers.push((name.clone(), value.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[test]
    fn rule_request_header_edits_are_reflected_in_the_captured_copy() {
        let mut headers = vec![
            ("X-Test".into(), "old-a".into()),
            ("x-test".into(), "old-b".into()),
            ("x-keep".into(), "yes".into()),
        ];
        apply_set_header_pairs(
            &mut headers,
            &[
                ("X-Test".into(), "new".into()),
                ("X-Added".into(), "1".into()),
            ],
        );
        assert_eq!(
            headers,
            vec![
                ("x-keep".into(), "yes".into()),
                ("X-Test".into(), "new".into()),
                ("X-Added".into(), "1".into()),
            ]
        );
    }

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
        assert!(captured
            .headers
            .iter()
            .any(|(k, v)| k == "set-cookie" && v == "a=1"));
        assert!(!captured
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("x-drop")));
    }

    #[test]
    fn apply_request_effects_mutates_wire_and_capture_together() {
        let mut wire = HeaderMap::new();
        wire.insert(
            HeaderName::from_static("x-old"),
            HeaderValue::from_static("1"),
        );
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
    fn invalid_script_headers_do_not_desynchronize_request_capture_from_wire() {
        let mut wire = HeaderMap::new();
        wire.insert(
            HeaderName::from_static("x-keep"),
            HeaderValue::from_static("original"),
        );
        let mut captured = vec![("x-keep".to_string(), "original".to_string())];
        apply_request_effects(
            &mut wire,
            &mut captured,
            Effects {
                header_ops: vec![
                    HeaderOp::Set("x-keep".into(), "bad\nvalue".into()),
                    HeaderOp::Add("bad header".into(), "value".into()),
                    HeaderOp::Remove("bad header".into()),
                ],
                status: None,
            },
        );

        assert_eq!(
            wire.get("x-keep").and_then(|value| value.to_str().ok()),
            Some("original")
        );
        assert_eq!(captured, vec![("x-keep".into(), "original".into())]);
    }

    #[test]
    fn invalid_script_headers_are_not_recorded_on_responses() {
        let mut captured = CapturedResponse {
            status: 200,
            version: "HTTP/1.1".into(),
            headers: vec![("x-keep".into(), "original".into())],
            body: Bytes::new(),
            timestamp_ms: 0,
        };
        apply_response_effects(
            &mut captured,
            Effects {
                header_ops: vec![
                    HeaderOp::Set("x-keep".into(), "bad\nvalue".into()),
                    HeaderOp::Add("bad header".into(), "value".into()),
                    HeaderOp::Remove("bad header".into()),
                ],
                status: None,
            },
        );

        assert_eq!(captured.headers, vec![("x-keep".into(), "original".into())]);
    }

    #[test]
    fn request_framing_restores_original_values_and_drops_consumed_trailers() {
        let mut original = HeaderMap::new();
        original.insert(CONTENT_LENGTH, HeaderValue::from_static("12"));
        original.insert(TRAILER, HeaderValue::from_static("x-checksum"));
        let original_pairs = header_pairs(&original);

        let mut wire = HeaderMap::new();
        wire.insert(CONTENT_LENGTH, HeaderValue::from_static("1"));
        wire.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        wire.insert(TRAILER, HeaderValue::from_static("x-scripted"));
        restore_wire_framing(&mut wire, &original, false);
        assert_eq!(
            wire.get(CONTENT_LENGTH),
            Some(&HeaderValue::from_static("12"))
        );
        assert!(wire.get(TRANSFER_ENCODING).is_none());
        assert!(wire.get(TRAILER).is_none());

        let mut captured = vec![
            ("content-length".into(), "1".into()),
            ("transfer-encoding".into(), "chunked".into()),
            ("trailer".into(), "x-scripted".into()),
        ];
        restore_message_framing(&mut captured, &original_pairs, false);
        assert_eq!(header_values(&captured, "content-length"), vec!["12"]);
        assert!(header_values(&captured, "transfer-encoding").is_empty());
        assert!(header_values(&captured, "trailer").is_empty());
    }

    #[test]
    fn streamed_message_preserves_the_original_trailer_declaration() {
        let original = vec![("trailer".into(), "x-checksum".into())];
        let mut captured = vec![("trailer".into(), "x-scripted".into())];
        restore_message_framing(&mut captured, &original, true);
        assert_eq!(header_values(&captured, "trailer"), vec!["x-checksum"]);
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
        assert_eq!(
            parts.uri.to_string(),
            "http://localhost:8080/ajax/agent_abc_1.js"
        );
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

    #[test]
    fn captured_https_origin_form_has_an_absolute_url() {
        let (parts, ()) = Request::builder()
            .uri("/api/items?q=1")
            .header(HOST, "api.example.com:8443")
            .body(())
            .expect("request")
            .into_parts();

        let captured = captured_request(&parts, "api.example.com:8443".to_string(), Bytes::new());

        assert_eq!(captured.scheme, "https");
        assert_eq!(captured.path, "/api/items?q=1");
        assert_eq!(captured.uri, "https://api.example.com:8443/api/items?q=1");
    }

    #[test]
    fn captured_plain_proxy_request_keeps_its_absolute_url() {
        let (parts, ()) = Request::builder()
            .uri("http://api.example.com:8080/api/items?q=1")
            .body(())
            .expect("request")
            .into_parts();

        let captured = captured_request(&parts, "api.example.com:8080".to_string(), Bytes::new());

        assert_eq!(captured.scheme, "http");
        assert_eq!(captured.uri, "http://api.example.com:8080/api/items?q=1");
    }

    #[test]
    fn reset_content_status_is_bodyless() {
        assert!(response_has_no_body("GET", 205));
        assert!(status_forbids_metadata(205));
    }

    #[tokio::test]
    async fn buffer_capped_small_body_is_fully_captured() {
        let (captured, forward, complete) = buffer_capped(Body::from(vec![1u8, 2, 3]), 64).await;
        assert_eq!(captured, vec![1, 2, 3]);
        assert!(
            forward.is_none(),
            "body within the cap needs no streaming forward"
        );
        assert!(complete, "a clean small body is complete");
    }

    #[tokio::test]
    async fn buffer_capped_exact_limit_is_fully_captured() {
        let data = vec![b'x'; 64];
        let (captured, forward, complete) = buffer_capped(Body::from(data.clone()), 64).await;
        assert_eq!(captured, data);
        assert!(forward.is_none(), "a body exactly at the cap is complete");
        assert!(complete);
    }

    #[tokio::test]
    async fn buffer_capped_truncates_capture_but_forwards_full_body() {
        let data = vec![b'x'; 100];
        let (captured, forward, complete) = buffer_capped(Body::from(data.clone()), 40).await;
        // Capture is capped...
        assert_eq!(captured.len(), 40);
        assert!(
            complete,
            "an over-cap body that streamed cleanly is complete"
        );
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
                return Poll::Ready(Some(Err(Error::from(std::io::Error::other(
                    "upstream reset",
                )))));
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
        Shared::new(
            max_flows,
            responder,
            crate::settings::ProxySettings::default(),
        )
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
            request_body_complete: true,
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
        assert!(
            shared.store.lock().unwrap().get("f1").is_none(),
            "f1 must be evicted"
        );

        let res = Response::builder()
            .status(200)
            .body(Body::from("hi"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.headers().get("x-rule").and_then(|v| v.to_str().ok()),
            Some("on"),
            "response-phase rules must still apply to an evicted flow's response"
        );
    }

    #[tokio::test]
    async fn declared_oversized_response_still_applies_metadata_rules() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetResponseHeader {
                name: "x-large-rule".into(),
                value: "applied".into(),
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));

        let res = Response::builder()
            .status(200)
            .header(CONTENT_LENGTH, (MAX_CAPTURE_BODY + 1).to_string())
            .body(Body::from("wire bytes"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.headers()
                .get("x-large-rule")
                .and_then(|value| value.to_str().ok()),
            Some("applied")
        );
        assert_eq!(out.collect().await.expect("body").to_bytes(), "wire bytes");
    }

    #[tokio::test]
    async fn declared_oversized_response_still_runs_response_scripts() {
        let shared = test_shared(10);
        shared
            .scripts
            .write()
            .expect("scripts")
            .set_scripts(vec![crate::scripting::Script {
                id: "large".into(),
                name: "large".into(),
                enabled: true,
                source: r#"fn on_response(req, res) { res.set_header("x-script", "applied"); }"#
                    .into(),
            }]);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .header(CONTENT_LENGTH, (MAX_CAPTURE_BODY + 1).to_string())
            .body(Body::from("wire bytes"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.headers()
                .get("x-script")
                .and_then(|value| value.to_str().ok()),
            Some("applied")
        );
    }

    #[tokio::test]
    async fn streamed_response_keeps_original_framing_after_script_edits() {
        let shared = test_shared(10);
        shared
            .scripts
            .write()
            .expect("scripts")
            .set_scripts(vec![crate::scripting::Script {
                id: "framing".into(),
                name: "framing".into(),
                enabled: true,
                source: r#"fn on_response(req, res) {
                    res.set_header("content-length", "1");
                    res.set_header("transfer-encoding", "chunked");
                }"#
                .into(),
            }]);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let original_length = (MAX_CAPTURE_BODY + 1).to_string();
        let response = Response::builder()
            .header(CONTENT_LENGTH, &original_length)
            .body(Body::from("wire bytes"))
            .expect("response");

        let out = handler.process_response(response).await;

        assert_eq!(
            out.headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
            Some(original_length.as_str())
        );
        assert!(out.headers().get("transfer-encoding").is_none());
        let recorded = shared
            .store
            .lock()
            .expect("store")
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert_eq!(
            header_values(&recorded.headers, "content-length"),
            vec![original_length.as_str()]
        );
        assert!(header_values(&recorded.headers, "transfer-encoding").is_empty());
    }

    #[tokio::test]
    async fn buffered_body_rewrite_normalizes_wire_and_recorded_framing() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::RewriteResponseBody {
                find: "old".into(),
                replace: "a longer body".into(),
                regex: false,
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let response = Response::builder()
            .header(CONTENT_LENGTH, "3")
            .header(TRAILER, "x-checksum")
            .body(Body::from("old"))
            .expect("response");

        let out = handler.process_response(response).await;
        assert_eq!(
            out.headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
            Some("13")
        );
        assert!(out.headers().get(TRANSFER_ENCODING).is_none());
        assert!(out.headers().get(TRAILER).is_none());
        assert_eq!(
            out.collect().await.expect("body").to_bytes(),
            "a longer body"
        );

        let recorded = shared
            .store
            .lock()
            .expect("store")
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert_eq!(
            header_values(&recorded.headers, "content-length"),
            vec!["13"]
        );
        assert!(header_values(&recorded.headers, "transfer-encoding").is_empty());
        assert!(header_values(&recorded.headers, "trailer").is_empty());
    }

    #[tokio::test]
    async fn incomplete_stream_still_applies_metadata_rules_and_propagates_error() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetResponseHeader {
                name: "x-incomplete-rule".into(),
                value: "applied".into(),
            }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let body = Body::from(BoxBody::new(ErrAfter {
            data: Some(Bytes::from_static(b"prefix")),
            errored: false,
        }));
        let out = handler
            .process_response(Response::builder().body(body).expect("response"))
            .await;
        assert_eq!(
            out.headers()
                .get("x-incomplete-rule")
                .and_then(|value| value.to_str().ok()),
            Some("applied")
        );
        assert!(
            out.collect().await.is_err(),
            "the upstream stream error must still reach the client"
        );
    }

    #[tokio::test]
    async fn oversized_response_skips_body_rewrite_without_spending_fire_limit() {
        let mut action = responder_with(crate::rules::Action::RewriteResponseBody {
            find: "wire".into(),
            replace: "changed".into(),
            regex: false,
        });
        action.scenarios[1].rules[0].fire_limit = Some(1);
        let shared = shared_with_responder(10, action);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .header(CONTENT_LENGTH, (MAX_CAPTURE_BODY + 1).to_string())
            .body(Body::from("wire bytes"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(out.collect().await.expect("body").to_bytes(), "wire bytes");
        assert_eq!(
            shared
                .cursors
                .lock()
                .expect("cursors")
                .snapshot()
                .get("r")
                .copied(),
            None,
            "an unsafe skipped rewrite must remain eligible for a later buffered response"
        );
    }

    #[tokio::test]
    async fn rewriting_304_to_200_does_not_restore_the_304_resource_length() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetStatus { status: 200 }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .status(304)
            .header(CONTENT_LENGTH, "5000")
            .body(Body::empty())
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(out.status().as_u16(), 200);
        assert_ne!(
            out.headers()
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()),
            Some("5000")
        );
        assert!(out.collect().await.expect("body").to_bytes().is_empty());
    }

    #[tokio::test]
    async fn streaming_304_rewritten_to_200_drops_stale_framing_from_wire_and_capture() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetStatus { status: 200 }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .status(304)
            .header(CONTENT_LENGTH, (MAX_CAPTURE_BODY + 1).to_string())
            .header(TRANSFER_ENCODING, "chunked")
            .body(Body::empty())
            .expect("response");

        let out = handler.process_response(res).await;
        assert_eq!(out.status().as_u16(), 200);
        assert!(out.headers().get(CONTENT_LENGTH).is_none());
        assert!(out.headers().get(TRANSFER_ENCODING).is_none());
        let recorded = shared
            .store
            .lock()
            .expect("store")
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert!(header_values(&recorded.headers, "content-length").is_empty());
        assert!(header_values(&recorded.headers, "transfer-encoding").is_empty());
    }

    #[tokio::test]
    async fn rewriting_200_to_304_drops_body_and_reports_representation_length() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetStatus { status: 304 }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .status(200)
            .body(Body::from("hello"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(out.status().as_u16(), 304);
        assert_eq!(
            out.headers()
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()),
            Some("5")
        );
        assert!(out.collect().await.expect("body").to_bytes().is_empty());
        let recorded = shared
            .store
            .lock()
            .expect("store")
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert!(
            recorded.body.is_empty(),
            "the inspector must match the bodyless wire response"
        );
        assert_eq!(
            header_values(&recorded.headers, "content-length"),
            vec!["5"]
        );
        assert!(header_values(&recorded.headers, "transfer-encoding").is_empty());
    }

    #[tokio::test]
    async fn rewriting_large_response_to_204_cancels_stream_and_drops_length() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetStatus { status: 204 }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));
        let res = Response::builder()
            .status(200)
            .header(CONTENT_LENGTH, (MAX_CAPTURE_BODY + 1).to_string())
            .body(Body::from("must not escape"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(out.status().as_u16(), 204);
        assert!(out.headers().get(CONTENT_LENGTH).is_none());
        assert!(out.collect().await.expect("body").to_bytes().is_empty());
        let recorded = shared
            .store
            .lock()
            .expect("store")
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert!(header_values(&recorded.headers, "content-length").is_empty());
        assert!(header_values(&recorded.headers, "transfer-encoding").is_empty());
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
            out.headers()
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()),
            Some("5000"),
            "HEAD's resource Content-Length must be restored even after eviction"
        );
    }

    #[tokio::test]
    async fn invalid_set_status_falls_back_to_200_keeping_headers() {
        let shared = shared_with_responder(
            10,
            responder_with(crate::rules::Action::SetStatus { status: 1000 }),
        );
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));

        let res = Response::builder()
            .status(200)
            .header("x-upstream", "1")
            .body(Body::from("hi"))
            .expect("response");
        let out = handler.process_response(res).await;
        assert_eq!(
            out.status().as_u16(),
            200,
            "an out-of-range SetStatus falls back to 200"
        );
        assert_eq!(
            out.headers()
                .get("x-upstream")
                .and_then(|v| v.to_str().ok()),
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
        let out = handler
            .serve_synthetic("f1", "rule", synthetic, &req, true)
            .await;
        assert_eq!(
            out.headers().get("x-mock").and_then(|v| v.to_str().ok()),
            Some("1"),
            "configured headers must survive an invalid status"
        );
        assert_eq!(
            out.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
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
    async fn invalid_mock_headers_are_absent_from_both_wire_and_store() {
        let shared = test_shared(10);
        let handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        let synthetic = SyntheticResponse {
            status: 200,
            headers: vec![
                ("x-valid".into(), "yes".into()),
                ("bad header".into(), "value".into()),
                ("x-invalid-value".into(), "bad\nvalue".into()),
            ],
            body: b"mock".to_vec().into(),
        };

        let out = handler
            .serve_synthetic("f1", "rule", synthetic, &test_request(), true)
            .await;
        assert_eq!(
            out.headers()
                .get("x-valid")
                .and_then(|value| value.to_str().ok()),
            Some("yes")
        );
        assert!(out.headers().get("x-invalid-value").is_none());
        let recorded = shared
            .store
            .lock()
            .unwrap()
            .get("f1")
            .and_then(|flow| flow.response.clone())
            .expect("recorded response");
        assert_eq!(
            recorded.headers,
            vec![
                ("x-valid".into(), "yes".into()),
                ("content-length".into(), "4".into()),
            ]
        );
    }

    #[tokio::test]
    async fn mock_response_waits_for_the_configured_delay() {
        let shared = Shared::new(
            10,
            crate::rules::AutoResponder::default(),
            crate::settings::ProxySettings {
                response_delay_ms: 60,
                ..Default::default()
            },
        );
        let handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        let synthetic = SyntheticResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"mock".to_vec().into(),
        };
        let start = Instant::now();
        let _ = handler
            .serve_synthetic("f1", "rule", synthetic, &test_request(), true)
            .await;
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
        let _ = handler
            .serve_synthetic("f1", "rule", synthetic, &test_request(), true)
            .await;
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
            out.headers()
                .get("content-disposition")
                .map(HeaderValue::as_bytes),
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
            out.headers()
                .get("content-disposition")
                .map(HeaderValue::as_bytes),
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
            out.headers()
                .get("content-disposition")
                .map(HeaderValue::as_bytes),
            Some(b"inline".as_slice()),
            "a rule that rewrites the header must win with its new value"
        );
    }

    #[tokio::test]
    async fn appending_a_header_preserves_existing_obs_text_bytes() {
        let shared = test_shared(10);
        shared
            .scripts
            .write()
            .expect("scripts")
            .set_scripts(vec![crate::scripting::Script {
            id: "append".into(),
            name: "append".into(),
            enabled: true,
            source:
                r#"fn on_response(req, res) { res.add_header("content-disposition", "inline"); }"#
                    .into(),
        }]);
        let mut handler = CaptureHandler::new(Arc::clone(&shared));
        shared.record_new(pending_flow("f1"));
        handler.inflight = Some(inflight_for("f1", test_request()));

        let out = handler.process_response(obs_text_response()).await;
        let values = out
            .headers()
            .get_all("content-disposition")
            .iter()
            .map(HeaderValue::as_bytes)
            .collect::<Vec<_>>();
        assert_eq!(values, vec![LATIN1_DISPOSITION, b"inline"]);
    }

    #[tokio::test]
    async fn buffer_capped_marks_mid_body_error_incomplete() {
        let body = Body::from(BoxBody::new(ErrAfter {
            data: Some(Bytes::from_static(b"partial")),
            errored: false,
        }));
        let (captured, forward, complete) = buffer_capped(body, 1024).await;
        assert_eq!(
            captured,
            b"partial".as_slice(),
            "the prefix before the error is captured"
        );
        assert!(!complete, "a mid-body error marks the capture incomplete");
        // The forwarded body must surface the error (not end cleanly), so the
        // client sees a failed transfer rather than a falsely-complete response.
        let err = forward
            .expect("an errored body returns a forward that propagates the error")
            .collect()
            .await;
        assert!(
            err.is_err(),
            "the forwarded body propagates the upstream error"
        );
    }
}
