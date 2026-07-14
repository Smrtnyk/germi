//! Re-issue a captured request to a real server — the engine's first *outbound*
//! capability (everything else only ever responds). Today it powers the doc
//! public-availability check (issue #40); it is the seed of a future repeater.
//!
//! The availability check re-sends a doc request **stripped of credentials** and
//! follows ordinary redirects. Redirects whose target is recognizably an
//! authentication endpoint remain a protected signal instead of being followed
//! to a login page whose 200 would look public.

use std::collections::HashSet;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Empty;
use hyper::header::{HeaderName, HeaderValue, LOCATION};
use hyper::{Method, Request, Uri};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use url::Url;

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
const MAX_REDIRECTS: usize = 5;

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
    let Some(url) = sanitize_url(&target.url) else {
        return Availability {
            verdict: AvailabilityVerdict::Error,
            status: None,
            location: None,
        };
    };
    match tokio::time::timeout(timeout, check_public_inner(client, target, url)).await {
        Ok(availability) => availability,
        Err(_) => Availability {
            verdict: AvailabilityVerdict::Error,
            status: None,
            location: None,
        },
    }
}

async fn check_public_inner(
    client: &HttpsClient,
    target: &ReissueTarget,
    mut url: Url,
) -> Availability {
    // Captured headers belong to the original origin. Once a redirect crosses
    // origins, never resurrect them later in the chain: values such as Referer
    // and vendor-specific context headers are not credentials by name, but can
    // still disclose private request data to the redirect target.
    let mut forward_original_headers = true;
    for redirect_count in 0..=MAX_REDIRECTS {
        let Some(req) = build_request(target, &url, forward_original_headers) else {
            return Availability {
                verdict: AvailabilityVerdict::Error,
                status: None,
                location: None,
            };
        };
        let Ok(resp) = client.request(req).await else {
            return Availability {
                verdict: AvailabilityVerdict::Error,
                status: None,
                location: None,
            };
        };
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if !is_redirect_status(status) {
            return Availability {
                verdict: classify(status),
                status: Some(status),
                location: None,
            };
        }
        let Some(raw_location) = location else {
            return Availability {
                verdict: AvailabilityVerdict::Unknown,
                status: Some(status),
                location: None,
            };
        };
        let Some(next) = url
            .join(&raw_location)
            .ok()
            .and_then(|next| sanitize_url(next.as_str()))
        else {
            return Availability {
                verdict: AvailabilityVerdict::Unknown,
                status: Some(status),
                location: Some(raw_location),
            };
        };
        if is_login_url(&next) {
            return Availability {
                verdict: AvailabilityVerdict::Protected,
                status: Some(status),
                location: Some(raw_location),
            };
        }
        if redirect_count == MAX_REDIRECTS {
            return Availability {
                verdict: AvailabilityVerdict::Unknown,
                status: Some(status),
                location: Some(raw_location),
            };
        }
        if url.origin() != next.origin() {
            forward_original_headers = false;
        }
        url = next;
    }
    unreachable!("the redirect loop always returns or advances")
}

/// Build the credential-stripped GET/HEAD request. `None` if the URL or method
/// is unusable (→ `Error` verdict).
fn build_request(
    target: &ReissueTarget,
    url: &Url,
    forward_original_headers: bool,
) -> Option<Request<Empty<Bytes>>> {
    let uri: Uri = url.as_str().parse().ok()?;
    let method = Method::from_bytes(target.method.as_bytes()).ok()?;
    let mut req = Request::new(Empty::<Bytes>::new());
    *req.method_mut() = method;
    *req.uri_mut() = uri;
    let connection_nominated = connection_nominated_headers(&target.headers);
    for (k, v) in target.headers.iter().filter(|_| forward_original_headers) {
        if is_stripped(k) || connection_nominated.contains(&k.to_ascii_lowercase()) {
            continue;
        }
        // Skip any header that won't round-trip rather than poisoning the request.
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            // Preserve repeated end-to-end fields (for example multiple Accept
            // or X-Forwarded-* values). `insert` silently kept only the final
            // captured value and could make the anonymous probe exercise a
            // materially different request.
            req.headers_mut().append(name, val);
        }
    }
    Some(req)
}

/// RFC 9110 lets `Connection` name additional hop-by-hop fields. Dropping only
/// the fixed `Connection` header would incorrectly forward those nominated
/// values (which may contain private proxy/client context) on the probe.
fn connection_nominated_headers(headers: &[(String, String)]) -> HashSet<String> {
    headers
        .iter()
        .filter(|(name, _)| {
            name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("proxy-connection")
        })
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn sanitize_url(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !is_credential_name(name))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    Some(url)
}

fn is_credential_name(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "accesskeyid",
        "accesstoken",
        "apikey",
        "assertion",
        "authorization",
        "auth",
        "authtoken",
        "awsaccesskeyid",
        "clientsecret",
        "code",
        "cookie",
        "credential",
        "idtoken",
        "jwt",
        "key",
        "keypairid",
        "password",
        "passwd",
        "refreshtoken",
        "secret",
        "session",
        "sessionid",
        "sig",
        "signature",
        "ticket",
        "token",
    ];
    const SUFFIXES: &[&str] = &[
        "_access_key_id",
        "_api_key",
        "_assertion",
        "_auth",
        "_code",
        "_cookie",
        "_credential",
        "_jwt",
        "_key_pair_id",
        "_password",
        "_secret",
        "_session",
        "_session_id",
        "_sig",
        "_signature",
        "_ticket",
        "_token",
    ];
    let lower = name.to_ascii_lowercase();
    let mut normalized = String::with_capacity(name.len());
    let mut previous_lower_or_digit = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if ch.is_ascii_uppercase() && previous_lower_or_digit && !normalized.ends_with('_') {
                normalized.push('_');
            }
            normalized.push(ch.to_ascii_lowercase());
            previous_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        } else {
            if !normalized.is_empty() && !normalized.ends_with('_') {
                normalized.push('_');
            }
            previous_lower_or_digit = false;
        }
    }
    // The exact list is intentionally punctuation-agnostic: common spellings
    // such as `api_key`, `api-key`, and `apiKey` all compact to `apikey`.
    // Keep the separator-preserving form as well so vendor-prefixed suffixes
    // (`x_api_key`) remain distinguishable from benign substring collisions.
    let compact: String = lower
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    EXACT.contains(&compact.as_str()) || SUFFIXES.iter().any(|suffix| normalized.ends_with(suffix))
}

fn is_login_url(url: &Url) -> bool {
    url.path_segments().is_some_and(|mut segments| {
        segments.any(|segment| {
            let normalized: String = segment
                .split(['.', ';'])
                .next()
                .unwrap_or(segment)
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            matches!(
                normalized.as_str(),
                "login"
                    | "signin"
                    | "signon"
                    | "auth"
                    | "authorize"
                    | "authorization"
                    | "oauth"
                    | "oauth2"
                    | "sso"
            )
        })
    })
}

fn is_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Headers dropped before re-issuing: credentials (so we test anonymous access),
/// conditional/range headers (so we don't get a misleading 304/206), and
/// framing/hop-by-hop headers (rebuilt by the client for an empty-body request).
fn is_stripped(name: &str) -> bool {
    const STRIP_EXACT: &[&str] = &[
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
    // Strip anything credential-bearing so the re-fetch genuinely tests anonymous
    // access — not just Cookie/Authorization but arbitrary API-key, auth-token,
    // session and secret headers (incl. vendor-specific ones like x-api-key or
    // x-amz-security-token). Over-stripping only makes the probe stricter, which
    // is the safe direction for a "is this public?" check.
    const CREDENTIAL_MARKERS: &[&str] = &[
        "cookie",
        "auth",
        "token",
        "key",
        "secret",
        "session",
        "credential",
        "password",
    ];
    let lower = name.to_ascii_lowercase();
    STRIP_EXACT.contains(&lower.as_str()) || CREDENTIAL_MARKERS.iter().any(|m| lower.contains(m))
}

fn classify(status: u16) -> AvailabilityVerdict {
    match status {
        200..=299 => AvailabilityVerdict::Public,
        401 | 403 => AvailabilityVerdict::Protected,
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
    fn spawn_server(response: &[u8]) -> (SocketAddr, Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = channel();
        let response = response.to_vec();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(buf[..n].to_vec());
                let _ = s.write_all(&response);
                let _ = s.flush();
            }
        });
        (addr, rx)
    }

    fn spawn_sequence_server(responses: Vec<&'static [u8]>) -> (SocketAddr, Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(buf[..n].to_vec());
                let _ = stream.write_all(response);
                let _ = stream.flush();
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
        assert_eq!(
            a.location.as_deref(),
            Some("/login"),
            "the redirect target is captured"
        );
    }

    #[tokio::test]
    async fn ordinary_redirect_is_followed_before_classification() {
        let (addr, rx) = spawn_sequence_server(vec![
            b"HTTP/1.1 301 Moved Permanently\r\nLocation: /canonical\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ]);
        let a = check(addr, vec![("X-Benign".into(), "same-origin".into())]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Public);
        assert_eq!(a.status, Some(200));
        let first = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first request");
        let second = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("redirected request");
        assert!(String::from_utf8_lossy(&first).starts_with("GET /doc "));
        let second = String::from_utf8_lossy(&second).to_lowercase();
        assert!(second.starts_with("get /canonical "));
        assert!(
            second.contains("x-benign: same-origin"),
            "same-origin redirects retain benign captured headers"
        );
    }

    #[tokio::test]
    async fn cross_origin_redirect_drops_all_captured_headers() {
        let (redirect_addr, redirect_rx) =
            spawn_server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{redirect_addr}/public\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let (source_addr, _source_rx) = spawn_server(response.as_bytes());

        let availability = check(
            source_addr,
            vec![
                (
                    "Referer".into(),
                    "https://private.example/doc?share=secret".into(),
                ),
                ("X-Tenant-Context".into(), "private-tenant".into()),
                ("User-Agent".into(), "germi-test".into()),
            ],
        )
        .await;
        assert_eq!(availability.verdict, AvailabilityVerdict::Public);

        let redirected = redirect_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("redirect target saw a request");
        let redirected = String::from_utf8_lossy(&redirected).to_lowercase();
        for leaked in [
            "referer:",
            "share=secret",
            "x-tenant-context:",
            "private-tenant",
            "germi-test",
        ] {
            assert!(
                !redirected.contains(leaked),
                "cross-origin redirect leaked {leaked}: {redirected}"
            );
        }
    }

    #[tokio::test]
    async fn redirect_loop_is_unknown_not_protected() {
        let (addr, _rx) = spawn_server(
            b"HTTP/1.1 302 Found\r\nLocation: /canonical\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let a = check(addr, vec![]).await;
        assert_eq!(a.verdict, AvailabilityVerdict::Unknown);
        assert_eq!(a.status, Some(302));
        assert_eq!(a.location.as_deref(), Some("/canonical"));
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
        let (addr, _rx) =
            spawn_server(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
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
                ("X-Api-Key".into(), "live-api-key-value".into()),
                ("X-Amz-Security-Token".into(), "sts-token-value".into()),
                ("If-None-Match".into(), "\"etag\"".into()),
                ("Connection".into(), "X-Hop, keep-alive".into()),
                ("X-Hop".into(), "private proxy context".into()),
                ("User-Agent".into(), "germi-test".into()),
            ],
        )
        .await;
        assert_eq!(a.verdict, AvailabilityVerdict::Public);

        let sent = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server saw a request");
        let text = String::from_utf8_lossy(&sent).to_lowercase();
        assert!(!text.contains("cookie"), "Cookie must be stripped: {text}");
        assert!(
            !text.contains("authorization"),
            "Authorization must be stripped"
        );
        // Vendor/API credential headers must be stripped too, not just Cookie/Auth.
        assert!(!text.contains("x-api-key"), "X-Api-Key must be stripped");
        assert!(
            !text.contains("live-api-key-value"),
            "the API key value must not leak"
        );
        assert!(
            !text.contains("x-amz-security-token"),
            "STS token header must be stripped"
        );
        assert!(
            !text.contains("sts-token-value"),
            "the STS token value must not leak"
        );
        assert!(
            !text.contains("if-none-match"),
            "conditional headers must be stripped"
        );
        assert!(
            !text.contains("x-hop") && !text.contains("private proxy context"),
            "Connection-nominated headers must be stripped: {text}"
        );
        assert!(text.contains("user-agent"), "benign headers are preserved");
        assert!(text.contains("germi-test"));
    }

    #[test]
    fn strips_url_userinfo_and_credential_query_parameters() {
        let target = ReissueTarget {
            method: "GET".into(),
            url: "https://alice:secret@example.com/doc?token=abc&page=2&signature=deadbeef&lang=en"
                .into(),
            headers: vec![],
        };
        let sanitized = sanitize_url(&target.url).expect("sanitized URL");
        let request = build_request(&target, &sanitized, true).expect("request");
        assert_eq!(
            request.uri().to_string(),
            "https://example.com/doc?page=2&lang=en",
            "anonymous checks must not reuse credentials embedded in the URL"
        );
    }

    #[test]
    fn request_builder_preserves_repeated_benign_headers() {
        let target = ReissueTarget {
            method: "GET".into(),
            url: "https://example.com/doc".into(),
            headers: vec![
                ("X-Context".into(), "one".into()),
                ("X-Context".into(), "two".into()),
            ],
        };
        let url = sanitize_url(&target.url).expect("URL");
        let request = build_request(&target, &url, true).expect("request");
        let values: Vec<_> = request
            .headers()
            .get_all("x-context")
            .iter()
            .map(|value| value.to_str().expect("header text"))
            .collect();
        assert_eq!(values, ["one", "two"]);
    }

    #[test]
    fn strips_separator_variants_of_common_credential_parameters() {
        let sanitized = sanitize_url(
            "https://example.com/doc?api_key=a&api-key=b&access_key_id=c&AWSAccessKeyId=d&xApiKey=e&x--api--key=f&page=2",
        )
        .expect("sanitized URL");
        assert_eq!(sanitized.as_str(), "https://example.com/doc?page=2");
    }

    #[test]
    fn credential_query_detection_keeps_benign_substring_collisions() {
        let sanitized = sanitize_url(
            "https://example.com/doc?author=Ada&monkey=capuchin&zipcode=1000&auth_token=secret",
        )
        .expect("sanitized URL");
        assert_eq!(
            sanitized.as_str(),
            "https://example.com/doc?author=Ada&monkey=capuchin&zipcode=1000"
        );
    }

    #[test]
    fn only_real_redirect_statuses_are_followed() {
        for status in [301, 302, 303, 307, 308] {
            assert!(is_redirect_status(status), "{status} is a redirect");
        }
        for status in [300, 304, 305, 306, 309] {
            assert!(!is_redirect_status(status), "{status} is not followed");
        }
    }

    #[test]
    fn recognizes_common_login_path_spellings() {
        for url in [
            "https://example.com/users/sign_in",
            "https://example.com/Account/Login.aspx",
            "https://example.com/oauth2/authorize",
        ] {
            assert!(is_login_url(&Url::parse(url).expect("URL")), "{url}");
        }
        assert!(!is_login_url(
            &Url::parse("https://example.com/docs/authorization-guide").expect("URL")
        ));
    }
}
