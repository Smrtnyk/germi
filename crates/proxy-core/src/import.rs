//! Import captured traffic from external archives into [`Flow`]s.
//!
//! Supported: HAR 1.2 (browser/devtools exports) and Fiddler SAZ. Imported
//! flows slot into the same in-memory store as live captures, so they flow
//! through the list / inspector / mock paths unchanged.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Deserializer};

use crate::flow::{now_ms, CapturedRequest, CapturedResponse, Flow};
use crate::tester::parse_url;

// =============================== HAR 1.2 ===============================
//
// Real-world HARs (Chrome, Firefox, Charles, Playwright) omit many "required"
// fields, so every field here is optional/defaulted and unknown fields are
// ignored. `content.encoding == "base64"` is the ONLY binary signal — it is
// unrelated to HTTP Content-Encoding, so we never gunzip.

#[derive(Deserialize, Default)]
struct Har {
    #[serde(default)]
    log: HarLog,
}

#[derive(Deserialize, Default)]
struct HarLog {
    #[serde(default)]
    entries: Vec<HarEntry>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarEntry {
    #[serde(default)]
    request: HarRequest,
    #[serde(default)]
    response: HarResponse,
    #[serde(default)]
    time: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarRequest {
    #[serde(default)]
    method: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    http_version: String,
    #[serde(default)]
    headers: Vec<NameValue>,
    #[serde(default)]
    post_data: Option<PostData>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarResponse {
    // Lenient: a float / negative / out-of-range status from an off-spec exporter
    // becomes 0 instead of failing serde and aborting the WHOLE import.
    #[serde(default, deserialize_with = "lenient_status")]
    status: u16,
    #[serde(default)]
    http_version: String,
    #[serde(default)]
    headers: Vec<NameValue>,
    #[serde(default)]
    content: Content,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Content {
    #[serde(default)]
    text: String,
    #[serde(default)]
    encoding: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PostData {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, Default)]
struct NameValue {
    #[serde(default)]
    name: String,
    #[serde(default)]
    value: String,
}

fn pairs(headers: Vec<NameValue>) -> Vec<(String, String)> {
    headers.into_iter().map(|h| (h.name, h.value)).collect()
}

/// Accept any JSON number for an HTTP status, coercing out-of-range/float/negative
/// to 0 rather than failing the entire `serde_json::from_slice`.
fn lenient_status<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let n = v
        .as_u64()
        .or_else(|| v.as_f64().map(|f| f as u64))
        .unwrap_or(0);
    Ok(u16::try_from(n).unwrap_or(0))
}

fn decode_har_body(content: &Content) -> Vec<u8> {
    if content.text.is_empty() {
        return Vec::new();
    }
    if content.encoding.as_deref() == Some("base64") {
        // Lenient: tolerate whitespace/line-wraps and missing padding instead of
        // silently dropping the body of a real-world HAR.
        crate::body::base64_lenient(&content.text).unwrap_or_default()
    } else {
        content.text.clone().into_bytes()
    }
}

/// Parse a HAR 1.2 file into flows. Flow ids are left empty (assigned on insert).
pub fn parse_har(bytes: &[u8]) -> Result<Vec<Flow>> {
    let har: Har = serde_json::from_slice(bytes)?;
    let mut flows = Vec::with_capacity(har.log.entries.len());

    for entry in har.log.entries {
        let (scheme, host, path) = parse_url(&entry.request.url);
        let req_body = entry
            .request
            .post_data
            .map(|p| p.text.into_bytes())
            .unwrap_or_default();

        let request = CapturedRequest {
            method: if entry.request.method.is_empty() {
                "GET".to_string()
            } else {
                entry.request.method
            },
            uri: entry.request.url,
            scheme,
            host,
            path,
            version: entry.request.http_version,
            headers: pairs(entry.request.headers),
            body: req_body,
            timestamp_ms: now_ms(),
        };

        // No response captured if status is 0 and there are no headers.
        let response = if entry.response.status == 0 && entry.response.headers.is_empty() {
            None
        } else {
            Some(CapturedResponse {
                status: entry.response.status,
                version: entry.response.http_version,
                headers: pairs(entry.response.headers),
                body: decode_har_body(&entry.response.content),
                timestamp_ms: now_ms(),
            })
        };

        flows.push(Flow {
            id: String::new(),
            request,
            response,
            matched_rule: None,
            duration_ms: if entry.time > 0.0 {
                Some(entry.time as u64)
            } else {
                None
            },
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: true,
        });
    }

    Ok(flows)
}

// =============================== Fiddler SAZ ===============================
//
// A SAZ is a ZIP of raw HTTP wire files under `raw/`: `N_c.txt` (client request)
// and `N_s.txt` (server response), where N is the (variable-width, zero-padded)
// session number. Bodies are byte-exact as transferred, so we de-chunk THEN
// decompress per the headers. Unencrypted archives only.

#[derive(Default)]
struct SessionRaw {
    client: Option<Vec<u8>>,
    server: Option<Vec<u8>>,
}

/// Total decompressed-bytes budget for a whole SAZ import (members are also each
/// capped individually); a hostile archive with many members can't exceed this.
const SAZ_TOTAL_BUDGET: u64 = 512 * 1024 * 1024;

/// Parse a Fiddler SAZ (Session Archive Zip) into flows.
pub fn parse_saz(bytes: &[u8]) -> Result<Vec<Flow>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| anyhow::anyhow!("not a valid SAZ archive: {e}"))?;

    let re = Regex::new(r"(?i)^raw/(\d+)_([cs])\.txt$").unwrap();
    let names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();

    // Group by integer session number (never lexical — widths vary).
    let mut sessions: BTreeMap<u64, SessionRaw> = BTreeMap::new();
    // Bound total memory across ALL members (each is already per-member capped),
    // so an archive with a huge *number* of members can't exhaust memory.
    let mut total_bytes: u64 = 0;
    for name in names {
        let Some(caps) = re.captures(&name) else {
            continue;
        };
        // Skip entries whose session number doesn't parse (e.g. a crafted name
        // with 20+ digits that overflows u64) rather than folding them all into
        // session 0, which would clobber unrelated sessions.
        let Ok(n) = caps[1].parse::<u64>() else {
            continue;
        };
        if total_bytes > SAZ_TOTAL_BUDGET {
            tracing::warn!("SAZ import exceeded {SAZ_TOTAL_BUDGET} bytes; remaining sessions skipped");
            break;
        }
        let is_client = caps[2].eq_ignore_ascii_case("c");
        let entry = zip.by_name(&name).map_err(|_| {
            anyhow::anyhow!("could not read '{name}' (encrypted SAZ is not supported)")
        })?;
        let mut buf = Vec::new();
        // Cap how much we inflate from a single zip member so a small crafted
        // archive can't expand to gigabytes (zip-bomb) and exhaust memory.
        entry
            .take(crate::body::MAX_DECOMPRESSED_BYTES as u64)
            .read_to_end(&mut buf)
            .ok();
        total_bytes = total_bytes.saturating_add(buf.len() as u64);
        let slot = sessions.entry(n).or_default();
        if is_client {
            slot.client = Some(buf);
        } else {
            slot.server = Some(buf);
        }
    }

    let mut flows = Vec::new();
    for (_n, raw) in sessions {
        let Some(client) = raw.client else {
            continue;
        };
        let Ok(request) = parse_request(&client) else {
            continue; // skip unparseable sessions (e.g. odd CONNECT records)
        };
        let response = raw.server.as_deref().and_then(|s| parse_response(s).ok());
        flows.push(Flow {
            id: String::new(),
            request,
            response,
            matched_rule: None,
            duration_ms: None,
            ttfb_ms: None,
            comment: None,
            availability: None,
            imported: true,
        });
    }
    Ok(flows)
}

fn parse_request(raw: &[u8]) -> Result<CapturedRequest> {
    let (head, body) = split_head_body(raw);
    let mut hbuf = [httparse::EMPTY_HEADER; 100];
    let mut req = httparse::Request::new(&mut hbuf);
    if req.parse(head)?.is_partial() {
        anyhow::bail!("incomplete request head");
    }
    let method = req.method.unwrap_or("GET").to_string();
    let target = req.path.unwrap_or("/").to_string();
    let version = format!("HTTP/1.{}", req.version.unwrap_or(1));
    let headers = collect_headers(req.headers);
    let host_hdr = header_get(&headers, "host").unwrap_or_default();
    let body = decode_body(&headers, body);

    // Absolute-form (proxy) request lines carry the scheme; origin-form needs Host.
    let (scheme, host, path, uri) = if target.contains("://") {
        let (s, h, p) = parse_url(&target);
        (s, h, p, target)
    } else {
        let uri = format!("https://{host_hdr}{target}");
        ("https".to_string(), host_hdr, target, uri)
    };

    Ok(CapturedRequest {
        method,
        uri,
        scheme,
        host,
        path,
        version,
        headers,
        body,
        timestamp_ms: now_ms(),
    })
}

fn parse_response(raw: &[u8]) -> Result<CapturedResponse> {
    let (head, body) = split_head_body(raw);
    let mut hbuf = [httparse::EMPTY_HEADER; 100];
    let mut res = httparse::Response::new(&mut hbuf);
    if res.parse(head)?.is_partial() {
        anyhow::bail!("incomplete response head");
    }
    let headers = collect_headers(res.headers);
    let body = decode_body(&headers, body);
    Ok(CapturedResponse {
        status: res.code.unwrap_or(0),
        version: format!("HTTP/1.{}", res.version.unwrap_or(1)),
        headers,
        body,
        timestamp_ms: now_ms(),
    })
}

/// Split raw HTTP bytes into (head-incl-terminator, body). Falls back to bare LF.
fn split_head_body(raw: &[u8]) -> (&[u8], &[u8]) {
    if let Some(p) = find_sub(raw, b"\r\n\r\n") {
        (&raw[..p + 4], &raw[p + 4..])
    } else if let Some(p) = find_sub(raw, b"\n\n") {
        (&raw[..p + 2], &raw[p + 2..])
    } else {
        (raw, &[])
    }
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn collect_headers(hs: &[httparse::Header]) -> Vec<(String, String)> {
    hs.iter()
        .filter(|h| !h.name.is_empty())
        .map(|h| {
            (
                h.name.to_string(),
                String::from_utf8_lossy(h.value).into_owned(),
            )
        })
        .collect()
}

fn header_get(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
}

/// De-chunk (if chunked) then decompress (per Content-Encoding) a raw body.
fn decode_body(headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let te = header_get(headers, "transfer-encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stage1 = if te.contains("chunked") {
        dechunk(body)
    } else {
        body.to_vec()
    };
    match crate::body::content_encoding_of(headers) {
        Some(enc) => crate::body::try_decompress(&enc, &stage1).unwrap_or(stage1),
        None => stage1,
    }
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(eol) = find_sub(rest, b"\r\n") {
        let hex = rest[..eol]
            .split(|&b| b == b';')
            .next()
            .unwrap_or(&rest[..eol]);
        let size = std::str::from_utf8(hex)
            .ok()
            .and_then(|s| usize::from_str_radix(s.trim(), 16).ok())
            .unwrap_or(0);
        let data_start = eol + 2;
        if size == 0 {
            break;
        }
        let data_end = data_start.saturating_add(size);
        if data_end > rest.len() {
            out.extend_from_slice(&rest[data_start.min(rest.len())..]);
            break;
        }
        out.extend_from_slice(&rest[data_start..data_end]);
        rest = &rest[(data_end + 2).min(rest.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_har_with_base64_and_plain_bodies() {
        // "hi" base64 == "aGk=".
        let har = r#"{
          "log": {
            "version": "1.2",
            "entries": [
              {
                "time": 12.5,
                "request": { "method": "GET", "url": "https://api.test/users?q=1",
                  "headers": [{"name":"Accept","value":"application/json"}] },
                "response": { "status": 200, "httpVersion": "HTTP/1.1",
                  "headers": [{"name":"Content-Type","value":"application/json"}],
                  "content": { "mimeType": "application/json", "text": "{\"ok\":true}" } }
              },
              {
                "request": { "method": "GET", "url": "https://api.test/blob" },
                "response": { "status": 200, "headers": [],
                  "content": { "encoding": "base64", "text": "aGk=" } }
              }
            ]
          }
        }"#;
        let flows = parse_har(har.as_bytes()).unwrap();
        assert_eq!(flows.len(), 2);

        let f0 = &flows[0];
        assert_eq!(f0.request.method, "GET");
        assert_eq!(f0.request.host, "api.test");
        assert_eq!(f0.request.path, "/users?q=1");
        assert_eq!(f0.duration_ms, Some(12));
        let r0 = f0.response.as_ref().unwrap();
        assert_eq!(r0.status, 200);
        assert_eq!(r0.body, b"{\"ok\":true}");

        // base64 body decodes to "hi".
        assert_eq!(flows[1].response.as_ref().unwrap().body, b"hi");
    }

    #[test]
    fn tolerates_minimal_har() {
        let flows = parse_har(br#"{"log":{"entries":[]}}"#).unwrap();
        assert!(flows.is_empty());
    }

    #[test]
    fn tolerates_off_spec_status_without_aborting_import() {
        // A float, an out-of-range, and a valid status across three entries: the
        // bad ones coerce to 0 instead of failing the whole parse.
        let har = r#"{"log":{"entries":[
          {"request":{"url":"https://a/1"},"response":{"status":200.5,"headers":[{"name":"x","value":"1"}],"content":{}}},
          {"request":{"url":"https://a/2"},"response":{"status":99999,"headers":[{"name":"x","value":"1"}],"content":{}}},
          {"request":{"url":"https://a/3"},"response":{"status":204,"headers":[{"name":"x","value":"1"}],"content":{}}}
        ]}}"#;
        let flows = parse_har(har.as_bytes()).expect("a malformed status must not abort the import");
        assert_eq!(flows.len(), 3);
        // 200.5 truncates to 200; 99999 is out of u16 range so it falls back to 0.
        assert_eq!(flows[0].response.as_ref().unwrap().status, 200);
        assert_eq!(flows[1].response.as_ref().unwrap().status, 0);
        assert_eq!(flows[2].response.as_ref().unwrap().status, 204);
    }

    #[test]
    fn har_base64_tolerates_whitespace() {
        // "hi" base64 with an embedded newline still decodes.
        let har = r#"{"log":{"entries":[
          {"request":{"url":"https://a/b"},"response":{"status":200,"headers":[],
            "content":{"encoding":"base64","text":"aG\nk="}}}
        ]}}"#;
        let flows = parse_har(har.as_bytes()).unwrap();
        assert_eq!(flows[0].response.as_ref().unwrap().body, b"hi");
    }

    #[test]
    fn dechunks_body() {
        assert_eq!(dechunk(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
    }

    #[test]
    fn parses_raw_request_and_response() {
        let req = b"POST /api/login HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\n\r\n{\"u\":1}";
        let r = parse_request(req).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.host, "api.test");
        assert_eq!(r.path, "/api/login");
        assert_eq!(r.uri, "https://api.test/api/login");
        assert_eq!(r.body, b"{\"u\":1}");

        let res = b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope";
        let resp = parse_response(res).unwrap();
        assert_eq!(resp.status, 404);
        assert_eq!(resp.body, b"nope");
    }

    #[test]
    fn decodes_chunked_gzip_response() {
        use std::io::Write;
        let mut enc =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"hello world").unwrap();
        let gz = enc.finish().unwrap();

        let mut raw = Vec::new();
        raw.extend_from_slice(
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n",
        );
        raw.extend_from_slice(format!("{:x}\r\n", gz.len()).as_bytes());
        raw.extend_from_slice(&gz);
        raw.extend_from_slice(b"\r\n0\r\n\r\n");

        let resp = parse_response(&raw).unwrap();
        assert_eq!(resp.body, b"hello world");
    }
}
