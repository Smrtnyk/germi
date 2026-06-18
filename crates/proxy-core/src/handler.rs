//! The hudsucker handler: captures every request/response, applies rules, and
//! streams events.
//!
//! hudsucker clones the handler and uses the *same clone* for a given
//! request/response pair, so we stash the in-flight flow id + start time on
//! `self` in `handle_request` and read them back in `handle_response`.

use std::sync::Arc;
use std::time::Instant;

use http_body_util::BodyExt;
use hudsucker::hyper::header::{HeaderName, HeaderValue, HOST};
use hudsucker::hyper::{HeaderMap, Request, Response};
use hudsucker::tokio_tungstenite::tungstenite::Message;
use hudsucker::{
    Body, HttpContext, HttpHandler, RequestOrResponse, WebSocketContext, WebSocketHandler,
};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};
use crate::rules::{RequestOutcome, SyntheticResponse};
use crate::shared::Shared;

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
        let body_bytes = read_body(body).await;

        let host = parts
            .headers
            .get(HOST)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| parts.uri.host().map(|s| s.to_string()))
            .unwrap_or_default();

        // Excluded hosts: forward plain HTTP without recording. (Excluded HTTPS
        // is tunneled at CONNECT via `should_intercept`, so never reaches here.)
        if self.shared.is_excluded(&host) {
            self.inflight = None;
            return Request::from_parts(parts, Body::from(body_bytes)).into();
        }

        let scheme = parts
            .uri
            .scheme_str()
            .unwrap_or("https") // intercepted CONNECT traffic is https
            .to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());

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
            .map(|ar| ar.evaluate_request(&captured))
            .unwrap_or(RequestOutcome::Continue {
                set_headers: vec![],
            });

        let id = self.shared.next_id();
        let start = Instant::now();

        // Emit the request immediately (response pending).
        self.shared.record_new(Flow {
            id: id.clone(),
            request: captured,
            response: None,
            matched_rule: None,
            duration_ms: None,
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
                Request::from_parts(parts, Body::from(body_bytes)).into()
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
        let body_bytes = read_body(body).await;

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
                .record_complete(&inflight.id, captured, duration, matched);
        }

        out
    }

    /// Decide whether to MITM a CONNECT. Excluded hosts return `false`, so
    /// hudsucker blind-tunnels them (no certificate, decryption, or capture).
    async fn should_intercept(&mut self, _ctx: &HttpContext, req: &Request<Body>) -> bool {
        let host = req.uri().host().unwrap_or_default();
        !self.shared.is_excluded(host)
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
            .record_complete(id, captured, 0, Some(rule.to_string()));
    }
}

impl WebSocketHandler for CaptureHandler {
    async fn handle_message(&mut self, _ctx: &WebSocketContext, msg: Message) -> Option<Message> {
        // MVP: transparent pass-through. Phase 2 captures/edits WS frames here.
        Some(msg)
    }
}

async fn read_body(body: Body) -> Vec<u8> {
    match body.collect().await {
        Ok(collected) => collected.to_bytes().to_vec(),
        Err(_) => Vec::new(),
    }
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
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
        if let (Ok(name), Ok(val)) =
            (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v))
        {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(Body::from(body.to_vec()))
        .unwrap_or_else(|_| Response::new(Body::from(body.to_vec())))
}
