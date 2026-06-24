//! Re-issue a captured request to a real server — the engine's first *outbound*
//! capability (everything else only ever responds). Today it powers the doc
//! public-availability check (issue #40); it is the seed of a future repeater.
//!
//! The availability check re-sends a doc request **stripped of credentials** and
//! WITHOUT following redirects, then classifies the response: a hyper client is
//! used precisely because it never auto-follows redirects, so a `30x → /login`
//! stays visible as the "protected" signal it is.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::Empty;
use hyper::header::{HeaderName, HeaderValue, LOCATION};
use hyper::{Method, Request, Uri};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use crate::flow::{Availability, AvailabilityVerdict};

/// Outbound client: hyper-util's pooling client over a rustls (webpki-roots)
/// connector. `https_or_http` so plain-HTTP targets work too.
pub(crate) type HttpsClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;

/// What to re-issue: the original method, the absolute URL, and the captured
/// request headers (credentials are stripped at send time, not here).
pub(crate) struct ReissueTarget {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// Per-request ceiling for an availability check.
pub(crate) const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Build the shared outbound client. Uses an explicit aws-lc-rs provider (the
/// same one the proxy runs on) with the bundled webpki roots, so a check works
/// regardless of whether the proxy — and its process-default provider — has been
/// started yet.
pub(crate) fn build_client() -> HttpsClient {
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(hudsucker::rustls::crypto::aws_lc_rs::default_provider())
        .expect("aws-lc-rs provider builds a valid rustls client config")
        .https_or_http()
        .enable_http1()
        .build();
    Client::builder(TokioExecutor::new()).build(https)
}

/// Re-issue `target` without credentials and classify the response.
pub(crate) async fn check_public(
    client: &HttpsClient,
    target: &ReissueTarget,
    timeout: Duration,
) -> Availability {
    let Some(req) = build_request(target) else {
        return Availability { verdict: AvailabilityVerdict::Error, status: None, location: None };
    };
    match tokio::time::timeout(timeout, client.request(req)).await {
        Ok(Ok(resp)) => {
            let status = resp.status().as_u16();
            let location = resp
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            Availability { verdict: classify(status), status: Some(status), location }
        }
        // Connect error, protocol error, or timed out: not checkable.
        Ok(Err(_)) | Err(_) => {
            Availability { verdict: AvailabilityVerdict::Error, status: None, location: None }
        }
    }
}

/// Build the credential-stripped GET/HEAD request. `None` if the URL or method
/// is unusable (→ `Error` verdict).
fn build_request(target: &ReissueTarget) -> Option<Request<Empty<Bytes>>> {
    let uri: Uri = target.url.parse().ok()?;
    let method = Method::from_bytes(target.method.as_bytes()).ok()?;
    let mut req = Request::new(Empty::<Bytes>::new());
    *req.method_mut() = method;
    *req.uri_mut() = uri;
    for (k, v) in &target.headers {
        if is_stripped(k) {
            continue;
        }
        // Skip any header that won't round-trip rather than poisoning the request.
        if let (Ok(name), Ok(val)) =
            (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_bytes(v.as_bytes()))
        {
            req.headers_mut().insert(name, val);
        }
    }
    Some(req)
}

/// Headers dropped before re-issuing: credentials (so we test anonymous access),
/// conditional/range headers (so we don't get a misleading 304/206), and
/// framing/hop-by-hop headers (rebuilt by the client for an empty-body request).
fn is_stripped(name: &str) -> bool {
    const STRIP: &[&str] = &[
        "cookie",
        "authorization",
        "proxy-authorization",
        "if-none-match",
        "if-modified-since",
        "if-match",
        "if-unmodified-since",
        "if-range",
        "range",
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "proxy-connection",
        "upgrade",
        "keep-alive",
        "te",
        "trailer",
    ];
    STRIP.iter().any(|s| name.eq_ignore_ascii_case(s))
}

fn classify(status: u16) -> AvailabilityVerdict {
    match status {
        200..=299 => AvailabilityVerdict::Public,
        // Auth required (401/403) or redirected away — commonly to a login page.
        300..=399 | 401 | 403 => AvailabilityVerdict::Protected,
        404 | 410 => AvailabilityVerdict::NotFound,
        _ => AvailabilityVerdict::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc::{channel, Receiver};

    /// A blocking single-shot HTTP server on a background thread: records the raw
    /// request bytes (so tests can assert on what was sent) and replies with a
    /// canned response. Plain HTTP, reached via the client's `https_or_http`.
    fn spawn_server(response: &'static [u8]) -> (SocketAddr, Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(buf[..n].to_vec());
                let _ = s.write_all(response);
                let _ = s.flush();
            }
        });
        (addr, rx)
    }

    /// A server that accepts and reads but never replies, to exercise the timeout.
    fn spawn_blackhole() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind blackhole");
        let addr = listener.local_addr().expect("local addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                std::thread::sleep(Duration::from_secs(30));
            }
        });
        addr
    }

    fn target(addr: SocketAddr, headers: Vec<(String, String)>) -> ReissueTarget {
        ReissueTarget {
            method: "GET".to_string(),
            url: format!("http://{addr}/doc"),
            headers,
        }
    }

    async fn check(addr: SocketAddr, headers: Vec<(String, String)>) -> Availability {
        check_public(&build_client(), &target(addr, headers), CHECK_TIMEOUT).await
    }

    #[tokio::test]
    async fn ok_is_public() {
        let (addr, _rx) = spawn_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Public);
        assert_eq!(a.status, Some(200));
    }

    #[tokio::test]
    async fn unauthorized_is_protected() {
        let (addr, _rx) = spawn_server(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Protected);
        assert_eq!(a.status, Some(401));
    }

    #[tokio::test]
    async fn redirect_to_login_is_protected_and_not_followed() {
        // A 302 → /login is the auth signal; the client must NOT follow it (which
        // would otherwise surface the login page's 200 and read as "public").
        let (addr, _rx) =
            spawn_server(b"HTTP/1.1 302 Found\r\nLocation: /login\r\nContent-Length: 0\r\n\r\n");
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Protected);
        assert_eq!(a.status, Some(302));
        assert_eq!(a.location.as_deref(), Some("/login"), "the redirect target is captured");
    }

    #[tokio::test]
    async fn missing_is_not_found() {
        let (addr, _rx) = spawn_server(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::NotFound);
        assert_eq!(a.status, Some(404));
    }

    #[tokio::test]
    async fn server_error_is_unknown() {
        let (addr, _rx) = spawn_server(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Unknown);
        assert_eq!(a.status, Some(500));
    }

    #[tokio::test]
    async fn timeout_is_error() {
        let addr = spawn_blackhole();
        let a = check_public(
            &build_client(),
            &target(addr, vec![]),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(a.verdict, AvailabilityVerdict::Error);
        assert_eq!(a.status, None);
    }

    #[tokio::test]
    async fn invalid_url_is_error() {
        let bad = ReissueTarget {
            method: "GET".to_string(),
            url: "not a url".to_string(),
            headers: vec![],
        };
        let a = check_public(&build_client(), &bad, CHECK_TIMEOUT).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Error);
    }

    #[tokio::test]
    async fn strips_credentials_but_keeps_benign_headers() {
        let (addr, rx) = spawn_server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        let a = check(
            addr,
            vec![
                ("Cookie".into(), "session=secret".into()),
                ("Authorization".into(), "Bearer token".into()),
                ("If-None-Match".into(), "\"etag\"".into()),
                ("User-Agent".into(), "germi-test".into()),
            ],
        )
        .await;
        assert_eq!(a.verdict, AvailabilityVerdict::Public);

        let sent = rx.recv_timeout(Duration::from_secs(2)).expect("server saw a request");
        let text = String::from_utf8_lossy(&sent).to_lowercase();
        assert!(!text.contains("cookie"), "Cookie must be stripped: {text}");
        assert!(!text.contains("authorization"), "Authorization must be stripped");
        assert!(!text.contains("if-none-match"), "conditional headers must be stripped");
        assert!(text.contains("user-agent"), "benign headers are preserved");
        assert!(text.contains("germi-test"));
    }
}
