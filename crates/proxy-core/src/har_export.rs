//! Export captured traffic as a standard HAR 1.2 archive (issue #113). HAR is
//! the interchange format every HTTP tool reads, so a saved capture can be
//! shared with people who don't use Germi — the proprietary `.germi` session
//! format it replaces could not.
//!
//! Bodies are written *decoded* (Content-Encoding undone), matching what
//! browsers' devtools export: `content.text` is the readable payload, with
//! `encoding: "base64"` only when the decoded bytes aren't valid UTF-8. The
//! same convention is applied to request bodies via a non-standard `encoding`
//! key on `postData` (which [`crate::import::parse_har`] understands), so a
//! Germi-written HAR round-trips binary uploads losslessly. Germi-specific
//! provenance rides in the spec's extension escape hatch: the flow comment in
//! the standard `comment` field, the mocking rule in `_matchedRule`, and —
//! opted into at save time — the mock scenarios that shaped the traffic as a
//! log-level `_germiRules` bundle, which other tools ignore and a Germi
//! re-open offers to import. A rules-only export is the same envelope with
//! zero entries (see `rules_export`), so traffic and rules share one format.

use base64::Engine;
use serde::Serialize;

use crate::flow::{epoch_ms_to_rfc3339, header, Flow};
use crate::rules::Scenario;
use crate::rules_export::RulesExport;

#[derive(Serialize)]
struct Har<'a> {
    log: Log<'a>,
}

#[derive(Serialize)]
struct Log<'a> {
    version: &'static str,
    creator: Creator,
    entries: Vec<Entry<'a>>,
    #[serde(rename = "_germiRules", skip_serializing_if = "Option::is_none")]
    germi_rules: Option<RulesExport>,
}

#[derive(Serialize)]
struct Creator {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry<'a> {
    started_date_time: String,
    time: f64,
    request: Request<'a>,
    response: Response,
    cache: Empty,
    timings: Timings,
    #[serde(skip_serializing_if = "Option::is_none")]
    comment: Option<&'a str>,
    #[serde(rename = "_matchedRule", skip_serializing_if = "Option::is_none")]
    matched_rule: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    method: &'a str,
    url: &'a str,
    http_version: &'a str,
    cookies: Vec<Empty>,
    headers: Vec<NameValue>,
    query_string: Vec<NameValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    post_data: Option<PostData>,
    headers_size: i64,
    body_size: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status: u16,
    status_text: String,
    http_version: String,
    cookies: Vec<Empty>,
    headers: Vec<NameValue>,
    content: Content,
    #[serde(rename = "redirectURL")]
    redirect_url: String,
    headers_size: i64,
    body_size: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Content {
    size: u64,
    mime_type: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<&'static str>,
    #[serde(rename = "_germiBodyEncoded", skip_serializing_if = "is_false")]
    germi_body_encoded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PostData {
    mime_type: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<&'static str>,
    #[serde(rename = "_germiBodyEncoded", skip_serializing_if = "is_false")]
    germi_body_encoded: bool,
}

#[derive(Serialize)]
struct NameValue {
    name: String,
    value: String,
}

#[derive(Serialize)]
struct Timings {
    send: f64,
    wait: f64,
    receive: f64,
}

#[derive(Serialize)]
struct Empty {}

/// HAR's timing fields are JSON numbers, represented by `f64` in its schema.
#[allow(clippy::cast_precision_loss)]
fn ms_f64(ms: u64) -> f64 {
    ms as f64
}

// Serde's `skip_serializing_if` callback receives a reference to the field.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(value: &bool) -> bool {
    !*value
}

fn pairs(headers: &[(String, String)]) -> Vec<NameValue> {
    headers
        .iter()
        .map(|(name, value)| NameValue {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

/// Raw (undecoded) query parameters, split from the URL — HAR's `queryString`.
fn query_pairs(url: &str) -> Vec<NameValue> {
    let Some((_, query)) = url.split_once('?') else {
        return Vec::new();
    };
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (name, value) = p.split_once('=').unwrap_or((p, ""));
            NameValue {
                name: name.to_string(),
                value: value.to_string(),
            }
        })
        .collect()
}

/// A body in HAR `content` terms: (text, base64 marker, decoded size). The body
/// is decoded (Content-Encoding undone) first, then written as plain text when
/// it is valid UTF-8 and base64 otherwise.
fn body_text(
    headers: &[(String, String)],
    body: &[u8],
) -> (String, Option<&'static str>, u64, bool) {
    let has_http_encoding = !crate::body::content_encodings_of(headers).is_empty();
    let (decoded, germi_body_encoded) = match crate::body::decode_body(headers, body) {
        Some((decoded, false)) => (std::borrow::Cow::Owned(decoded), false),
        // A capped decode is only a prefix. Exporting that prefix would make a
        // save/open cycle silently destroy the original compressed payload, so
        // retain the exact raw bytes just as we do for an undecodable encoding.
        Some((_, true)) | None => (std::borrow::Cow::Borrowed(body), has_http_encoding),
    };
    let size = decoded.len() as u64;
    match std::str::from_utf8(&decoded) {
        Ok(text) => (text.to_string(), None, size, germi_body_encoded),
        Err(_) => (
            base64::engine::general_purpose::STANDARD.encode(&decoded),
            Some("base64"),
            size,
            germi_body_encoded,
        ),
    }
}

fn entry(flow: &Flow) -> Entry<'_> {
    let req = &flow.request;
    let post_data = if req.body.is_empty() {
        None
    } else {
        let (text, encoding, _, germi_body_encoded) = body_text(&req.headers, &req.body);
        Some(PostData {
            mime_type: header(&req.headers, "content-type")
                .unwrap_or("")
                .to_string(),
            text,
            encoding,
            germi_body_encoded,
        })
    };
    let request = Request {
        method: &req.method,
        url: &req.uri,
        http_version: &req.version,
        cookies: Vec::new(),
        headers: pairs(&req.headers),
        query_string: query_pairs(&req.uri),
        post_data,
        headers_size: -1,
        body_size: i64::try_from(req.body.len()).unwrap_or(i64::MAX),
    };

    // HAR requires a `response` object even for an unanswered request; a
    // status-0, header-less stub is the devtools convention for one, and is
    // exactly what `parse_har` maps back to `response: None`.
    let response = match &flow.response {
        Some(resp) => {
            let (text, encoding, size, germi_body_encoded) = body_text(&resp.headers, &resp.body);
            Response {
                status: resp.status,
                status_text: String::new(),
                http_version: resp.version.clone(),
                cookies: Vec::new(),
                headers: pairs(&resp.headers),
                content: Content {
                    size,
                    mime_type: header(&resp.headers, "content-type")
                        .unwrap_or("")
                        .to_string(),
                    text,
                    encoding,
                    germi_body_encoded,
                },
                redirect_url: header(&resp.headers, "location").unwrap_or("").to_string(),
                headers_size: -1,
                body_size: i64::try_from(resp.body.len()).unwrap_or(i64::MAX),
            }
        }
        None => Response {
            status: 0,
            status_text: String::new(),
            http_version: String::new(),
            cookies: Vec::new(),
            headers: Vec::new(),
            content: Content {
                size: 0,
                mime_type: String::new(),
                text: String::new(),
                encoding: None,
                germi_body_encoded: false,
            },
            redirect_url: String::new(),
            headers_size: -1,
            body_size: -1,
        },
    };

    let time = flow.duration_ms.map_or(-1.0, ms_f64);
    let wait = flow.ttfb_ms.map_or(-1.0, ms_f64);
    let receive = match (flow.duration_ms, flow.ttfb_ms) {
        (Some(total), Some(ttfb)) => ms_f64(total.saturating_sub(ttfb)),
        _ => -1.0,
    };
    Entry {
        started_date_time: epoch_ms_to_rfc3339(req.timestamp_ms),
        time,
        request,
        response,
        cache: Empty {},
        timings: Timings {
            send: if flow.response.is_some() { 0.0 } else { -1.0 },
            wait,
            receive,
        },
        comment: flow.comment.as_deref(),
        matched_rule: flow.matched_rule.as_deref(),
    }
}

/// Serialize flows into a HAR 1.2 archive (pretty JSON — HARs are routinely
/// opened in editors and diffed when shared). `Some(rules)` embeds those
/// scenarios as the `_germiRules` extension field — even an empty list, which
/// is how a pure rules export of an empty selection stays lossless; `None`
/// omits the field entirely (a plain traffic save).
pub fn export_har(flows: &[Flow], rules: Option<&[Scenario]>) -> Vec<u8> {
    let har = Har {
        log: Log {
            version: "1.2",
            creator: Creator {
                name: "germi",
                version: env!("CARGO_PKG_VERSION"),
            },
            entries: flows.iter().map(entry).collect(),
            germi_rules: rules.map(|r| RulesExport::new(r.to_vec())),
        },
    };
    serde_json::to_vec_pretty(&har).unwrap_or_else(|e| {
        tracing::error!("failed to serialize the HAR export: {e}");
        Vec::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{CapturedRequest, CapturedResponse};

    fn flow(req_body: &[u8], resp_body: &[u8]) -> Flow {
        Flow {
            id: "x".into(),
            seq: 1,
            request: CapturedRequest {
                method: "POST".into(),
                uri: "https://api.test/users?q=1&flag".into(),
                scheme: "https".into(),
                host: "api.test".into(),
                path: "/users?q=1&flag".into(),
                version: "HTTP/1.1".into(),
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: bytes::Bytes::copy_from_slice(req_body),
                timestamp_ms: 1_000_000_000_123,
            },
            response: Some(CapturedResponse {
                status: 201,
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Content-Type".into(), "text/plain; charset=utf-8".into()),
                    ("Location".into(), "https://api.test/users/7".into()),
                ],
                body: bytes::Bytes::copy_from_slice(resp_body),
                timestamp_ms: 1_000_000_000_160,
            }),
            matched_rule: Some("mock users".into()),
            duration_ms: Some(37),
            ttfb_ms: Some(12),
            comment: Some("triage note".into()),
            availability: None,
            imported: false,
        }
    }

    fn parse(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).expect("exported HAR is valid JSON")
    }

    #[test]
    fn exports_spec_shaped_har_12() {
        let har = parse(&export_har(&[flow(b"{\"u\":1}", b"created")], None));
        let log = &har["log"];
        assert_eq!(log["version"], "1.2");
        assert_eq!(log["creator"]["name"], "germi");

        let e = &log["entries"][0];
        assert_eq!(e["startedDateTime"], "2001-09-09T01:46:40.123Z");
        assert_eq!(e["time"], 37.0);
        assert_eq!(e["timings"]["wait"], 12.0);
        assert_eq!(e["timings"]["receive"], 25.0);
        assert_eq!(e["comment"], "triage note");
        assert_eq!(e["_matchedRule"], "mock users");

        let req = &e["request"];
        assert_eq!(req["method"], "POST");
        assert_eq!(req["url"], "https://api.test/users?q=1&flag");
        assert_eq!(req["httpVersion"], "HTTP/1.1");
        assert_eq!(req["queryString"][0]["name"], "q");
        assert_eq!(req["queryString"][0]["value"], "1");
        assert_eq!(req["queryString"][1]["name"], "flag");
        assert_eq!(req["postData"]["mimeType"], "application/json");
        assert_eq!(req["postData"]["text"], "{\"u\":1}");
        assert!(req["postData"].get("encoding").is_none());

        let resp = &e["response"];
        assert_eq!(resp["status"], 201);
        assert_eq!(resp["content"]["text"], "created");
        assert_eq!(resp["content"]["size"], 7);
        assert_eq!(resp["redirectURL"], "https://api.test/users/7");
    }

    #[test]
    fn round_trips_through_parse_har() {
        let original = flow(b"{\"u\":1}", &[0u8, 159, 146, 150]);
        let back = crate::import::parse_har(&export_har(std::slice::from_ref(&original), None))
            .expect("germi-written HAR parses");
        assert_eq!(back.len(), 1);
        let f = &back[0];
        assert_eq!(f.request.method, original.request.method);
        assert_eq!(f.request.uri, original.request.uri);
        assert_eq!(f.request.headers, original.request.headers);
        assert_eq!(
            f.request.body, original.request.body,
            "text request body survives"
        );
        assert_eq!(f.request.timestamp_ms, original.request.timestamp_ms);
        let (r, orig_r) = (
            f.response.as_ref().unwrap(),
            original.response.as_ref().unwrap(),
        );
        assert_eq!(r.status, orig_r.status);
        assert_eq!(r.headers, orig_r.headers);
        assert_eq!(
            r.body, orig_r.body,
            "binary response body survives via base64"
        );
        assert_eq!(
            r.timestamp_ms, orig_r.timestamp_ms,
            "resp ts reconstructs as start + time"
        );
        assert_eq!(f.duration_ms, original.duration_ms);
        assert_eq!(f.ttfb_ms, original.ttfb_ms);
        assert_eq!(f.comment, original.comment);
        assert_eq!(f.matched_rule, original.matched_rule);
        assert!(f.imported, "reopened captures are marked imported");
    }

    #[test]
    fn binary_request_body_round_trips_as_base64_post_data() {
        let original = flow(&[1u8, 2, 0, 255], b"ok");
        let har = parse(&export_har(std::slice::from_ref(&original), None));
        assert_eq!(
            har["log"]["entries"][0]["request"]["postData"]["encoding"],
            "base64"
        );
        let back =
            crate::import::parse_har(&export_har(std::slice::from_ref(&original), None)).unwrap();
        assert_eq!(back[0].request.body, original.request.body);
    }

    #[test]
    fn unanswered_request_round_trips_to_no_response() {
        let mut f = flow(b"", b"");
        f.response = None;
        f.duration_ms = None;
        f.ttfb_ms = None;
        let har = parse(&export_har(&[f.clone()], None));
        let e = &har["log"]["entries"][0];
        assert_eq!(
            e["response"]["status"], 0,
            "HAR still carries a stub response object"
        );
        assert_eq!(e["time"], -1.0);
        assert!(
            e["request"].get("postData").is_none(),
            "empty body → no postData"
        );

        let back = crate::import::parse_har(&export_har(&[f], None)).unwrap();
        assert!(back[0].response.is_none());
        assert_eq!(back[0].duration_ms, None);
        assert_eq!(back[0].ttfb_ms, None);
    }

    #[test]
    fn zero_and_long_timings_round_trip_without_becoming_unknown_or_clamped() {
        let mut zero = flow(b"", b"ok");
        zero.duration_ms = Some(0);
        zero.ttfb_ms = Some(0);
        let back = crate::import::parse_har(&export_har(&[zero], None)).unwrap();
        assert_eq!(back[0].duration_ms, Some(0));
        assert_eq!(back[0].ttfb_ms, Some(0));

        let mut long = flow(b"", b"ok");
        let duration = u64::from(u32::MAX) + 123;
        long.duration_ms = Some(duration);
        long.ttfb_ms = Some(duration - 1);
        let back = crate::import::parse_har(&export_har(&[long], None)).unwrap();
        assert_eq!(back[0].duration_ms, Some(duration));
        assert_eq!(back[0].ttfb_ms, Some(duration - 1));
    }

    fn mock_scenario() -> Scenario {
        use crate::rules::{Action, MatchKind, Matcher, Rule};
        Scenario {
            id: "sc-1".into(),
            name: "Checkout mocks".into(),
            rules: vec![Rule {
                id: "r-1".into(),
                enabled: true,
                fire_limit: None,
                repeat: false,
                matcher: Matcher {
                    method: None,
                    url: "/api".into(),
                    url_match: MatchKind::Contains,
                },
                action: Action::Block,
            }],
        }
    }

    #[test]
    fn rules_ride_in_the_germi_rules_extension_only_when_given() {
        let f = flow(b"", b"ok");
        let plain = parse(&export_har(std::slice::from_ref(&f), None));
        assert!(
            plain["log"].get("_germiRules").is_none(),
            "no bundle unless opted in"
        );

        let har = parse(&export_har(&[f], Some(&[mock_scenario()])));
        let bundle = &har["log"]["_germiRules"];
        assert_eq!(bundle["version"], 1);
        assert_eq!(bundle["scenarios"][0]["name"], "Checkout mocks");
        assert_eq!(
            bundle["scenarios"][0]["rules"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn embedded_rules_round_trip_through_extraction() {
        let bytes = export_har(&[flow(b"", b"ok")], Some(&[mock_scenario()]));
        let bundle = crate::import::har_embedded_rules(&bytes).expect("bundle extracted");

        let previews = crate::rules_export::preview_rules(&bundle).expect("previewable");
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].name, "Checkout mocks");
        assert_eq!(previews[0].rule_count, 1);

        let scenarios = crate::rules_export::parse_rules(&bundle).expect("bundle parses");
        assert_eq!(scenarios.len(), 1);
        assert_eq!(scenarios[0].rules.len(), 1);
        assert_ne!(scenarios[0].id, "sc-1", "imported scenarios are re-keyed");
    }

    #[test]
    fn har_without_the_extension_yields_no_embedded_rules() {
        let bytes = export_har(&[flow(b"", b"ok")], None);
        assert!(crate::import::har_embedded_rules(&bytes).is_none());
        assert!(crate::import::har_embedded_rules(b"not json").is_none());
    }

    #[test]
    fn compressed_bodies_are_exported_decoded() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"hello world").unwrap();
        let gz = enc.finish().unwrap();

        let mut f = flow(b"", &gz);
        f.response.as_mut().unwrap().headers = vec![
            ("Content-Type".into(), "text/plain".into()),
            ("Content-Encoding".into(), "gzip".into()),
        ];
        let bytes = export_har(&[f], None);
        let har = parse(&bytes);
        let content = &har["log"]["entries"][0]["response"]["content"];
        assert_eq!(
            content["text"], "hello world",
            "the shared HAR carries the readable body"
        );
        assert_eq!(content["size"], 11);
        assert!(content.get("encoding").is_none());
        assert!(content.get("_germiBodyEncoded").is_none());
        let reopened = crate::import::parse_har(&bytes).unwrap();
        let response = reopened[0].response.as_ref().unwrap();
        assert_eq!(response.body, b"hello world".as_slice());
        assert!(response
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("content-encoding")));
    }

    #[test]
    fn undecodable_encoded_body_round_trips_with_a_raw_marker() {
        let mut f = flow(b"", &[0, 1, 2]);
        f.response.as_mut().unwrap().headers = vec![
            ("Content-Type".into(), "application/octet-stream".into()),
            ("Content-Encoding".into(), "zstd".into()),
            ("Content-Length".into(), "3".into()),
        ];
        let bytes = export_har(&[f], None);
        let har = parse(&bytes);
        assert_eq!(
            har["log"]["entries"][0]["response"]["content"]["_germiBodyEncoded"],
            true
        );
        let reopened = crate::import::parse_har(&bytes).unwrap();
        let response = reopened[0].response.as_ref().unwrap();
        assert_eq!(response.body, [0, 1, 2].as_slice());
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("content-encoding") && value == "zstd"));
    }
}
