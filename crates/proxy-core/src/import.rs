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
    log: Option<HarLog>,
}

#[derive(Deserialize, Default)]
struct HarLog {
    #[serde(default)]
    entries: Option<Vec<HarEntry>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarEntry {
    #[serde(default, deserialize_with = "null_default")]
    started_date_time: String,
    #[serde(default, deserialize_with = "null_default")]
    request: HarRequest,
    #[serde(default, deserialize_with = "null_default")]
    response: HarResponse,
    #[serde(default = "unknown_time", deserialize_with = "null_unknown_time")]
    time: f64,
    #[serde(default, deserialize_with = "null_default")]
    timings: HarTimings,
    #[serde(default)]
    comment: Option<String>,
    /// Germi's own extension field (see `har_export`): the mock rule that
    /// produced this exchange, so provenance survives a HAR round-trip.
    #[serde(default, rename = "_matchedRule")]
    matched_rule: Option<String>,
}

#[derive(Deserialize, Default)]
struct HarTimings {
    /// Time-to-first-byte in HAR terms; `-1` means "not available".
    #[serde(default = "unknown_time", deserialize_with = "null_unknown_time")]
    wait: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HarRequest {
    #[serde(default, deserialize_with = "null_default")]
    method: String,
    #[serde(default, deserialize_with = "null_default")]
    url: String,
    #[serde(default, deserialize_with = "null_default")]
    http_version: String,
    #[serde(default, deserialize_with = "null_default")]
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
    #[serde(default, deserialize_with = "null_default")]
    http_version: String,
    #[serde(default, deserialize_with = "null_default")]
    headers: Vec<NameValue>,
    #[serde(default, deserialize_with = "null_default")]
    content: Content,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Content {
    #[serde(default, deserialize_with = "null_default")]
    text: String,
    #[serde(default)]
    encoding: Option<String>,
    /// Germi-only escape hatch: its exporter normally writes HTTP-decoded body
    /// bytes, but retains the exact encoded bytes when decompression is unsafe
    /// or unsupported. Without this marker an import must follow HAR convention
    /// and treat `text` as the decoded representation.
    #[serde(default, rename = "_germiBodyEncoded")]
    germi_body_encoded: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PostData {
    #[serde(default, deserialize_with = "null_default")]
    text: String,
    /// Non-standard but mirrored from `content.encoding`: Germi's own exporter
    /// (and some other tools) base64-encode binary request bodies.
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default, rename = "_germiBodyEncoded")]
    germi_body_encoded: bool,
}

#[derive(Deserialize, Default)]
struct NameValue {
    #[serde(default, deserialize_with = "null_default")]
    name: String,
    #[serde(default, deserialize_with = "null_default")]
    value: String,
}

/// Deserialize a value, treating an explicit JSON `null` as the type's default.
/// serde's `#[serde(default)]` only fills in a *missing* field, not one present
/// as `null` — some exporters emit `null` for absent values (`"time": null`,
/// `"headers": null`), which would otherwise abort the entire import.
fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

fn unknown_time() -> f64 {
    -1.0
}

/// Missing/null HAR timings mean unknown (`-1`), while an explicit zero is a
/// real measured duration and must survive import/export.
fn null_unknown_time<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or_else(unknown_time))
}

fn pairs(headers: Vec<NameValue>) -> Vec<(String, String)> {
    headers.into_iter().map(|h| (h.name, h.value)).collect()
}

/// HAR body fields conventionally contain the HTTP-decoded representation even
/// though the captured header list still describes the wire payload. Normalize
/// those headers to the bytes we actually store so replay/cURL/mock paths never
/// send identity bytes mislabeled as gzip (or as still chunked). Germi's raw-body
/// extension retains Content-Encoding for its exact-byte fallback.
fn normalize_har_body_headers(headers: &mut Vec<(String, String)>, body_is_http_encoded: bool) {
    let decoded_content = !body_is_http_encoded
        && headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-encoding"));
    let had_transfer_encoding = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"));
    headers.retain(|(name, _)| {
        !(name.eq_ignore_ascii_case("transfer-encoding")
            || decoded_content && name.eq_ignore_ascii_case("content-encoding")
            || (decoded_content || had_transfer_encoding)
                && name.eq_ignore_ascii_case("content-length"))
    });
}

/// Accept any JSON number for an HTTP status, coercing out-of-range/float/negative
/// to 0 rather than failing the entire `serde_json::from_slice`.
fn lenient_status<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let n = v.as_u64().unwrap_or(0);
    Ok(u16::try_from(n).unwrap_or(0))
}

fn decode_har_body(content: &Content) -> Vec<u8> {
    if content.text.is_empty() {
        return Vec::new();
    }
    if content
        .encoding
        .as_deref()
        .is_some_and(|encoding| encoding.eq_ignore_ascii_case("base64"))
    {
        // Lenient: tolerate whitespace/line-wraps and missing padding instead of
        // silently dropping the body of a real-world HAR. If an exporter marks
        // plain text as base64 by mistake, preserve those bytes rather than
        // replacing the only copy with an empty body.
        crate::body::base64_lenient(&content.text)
            .unwrap_or_else(|| content.text.as_bytes().to_vec())
    } else {
        content.text.clone().into_bytes()
    }
}

/// Just the `_germiRules` extension field (see `har_export`), so an open can
/// peek for embedded scenarios without touching the entries.
#[derive(Deserialize, Default)]
struct HarRulesPeek {
    #[serde(default)]
    log: HarRulesLog,
}

#[derive(Deserialize, Default)]
struct HarRulesLog {
    #[serde(default, rename = "_germiRules")]
    germi_rules: Option<serde_json::Value>,
}

/// Extract the mock-rules bundle a Germi-written HAR may embed as `_germiRules`,
/// re-serialized to standalone bundle bytes so the rules-import path applies it
/// unchanged. `None` when the field is absent (every non-Germi HAR) or the file
/// isn't JSON.
pub fn har_embedded_rules(bytes: &[u8]) -> Option<Vec<u8>> {
    let peek: HarRulesPeek = serde_json::from_slice(bytes).ok()?;
    let bundle = peek.log.germi_rules?;
    serde_json::to_vec(&bundle).ok()
}

/// Parse a HAR 1.2 file into flows. Flow ids are left empty (assigned on insert).
pub fn parse_har(bytes: &[u8]) -> Result<Vec<Flow>> {
    let har: Har = serde_json::from_slice(bytes)?;
    let log = har
        .log
        .ok_or_else(|| anyhow::anyhow!("not a HAR archive: missing log object"))?;
    let entries = log
        .entries
        .ok_or_else(|| anyhow::anyhow!("not a HAR archive: missing log.entries array"))?;
    let entry_count = entries.len();
    let mut flows = Vec::with_capacity(entry_count);

    for entry in entries {
        if entry.request.url.trim().is_empty() {
            tracing::warn!("skipping HAR entry without a request URL");
            continue;
        }
        let (scheme, host, path) = parse_url(&entry.request.url);
        let (req_body, req_body_encoded) = entry.request.post_data.map_or_else(
            || (Vec::new(), false),
            |p| {
                let encoded = p.germi_body_encoded;
                if p.encoding
                    .as_deref()
                    .is_some_and(|encoding| encoding.eq_ignore_ascii_case("base64"))
                {
                    (
                        crate::body::base64_lenient(&p.text)
                            .unwrap_or_else(|| p.text.as_bytes().to_vec()),
                        encoded,
                    )
                } else {
                    (p.text.into_bytes(), encoded)
                }
            },
        );

        let duration_ms = if entry.time.is_finite() && entry.time >= 0.0 {
            Some(entry.time as u64)
        } else {
            None
        };
        let ts = crate::flow::rfc3339_to_epoch_ms(&entry.started_date_time).unwrap_or_else(now_ms);

        let mut request_headers = pairs(entry.request.headers);
        normalize_har_body_headers(&mut request_headers, req_body_encoded);
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
            headers: request_headers,
            body: req_body.into(),
            timestamp_ms: ts,
        };

        // Germi's unanswered-request HAR stub has status 0, no headers/version,
        // and an empty body. Do not classify every status-less response as that
        // stub: off-spec exporters sometimes omit status and headers while still
        // carrying the only copy of the response body.
        let response_body = decode_har_body(&entry.response.content);
        let response = if entry.response.status == 0
            && entry.response.headers.is_empty()
            && entry.response.http_version.is_empty()
            && response_body.is_empty()
        {
            None
        } else {
            let mut headers = pairs(entry.response.headers);
            normalize_har_body_headers(&mut headers, entry.response.content.germi_body_encoded);
            Some(CapturedResponse {
                status: entry.response.status,
                version: entry.response.http_version,
                headers,
                body: response_body.into(),
                // HAR has no response timestamp of its own; the entry's start
                // plus its total time is the closest reconstruction.
                timestamp_ms: ts.saturating_add(duration_ms.unwrap_or(0)),
            })
        };

        flows.push(Flow {
            id: String::new(),
            seq: 0,
            request,
            response,
            matched_rule: entry.matched_rule,
            duration_ms,
            ttfb_ms: if entry.timings.wait.is_finite() && entry.timings.wait >= 0.0 {
                Some(entry.timings.wait as u64)
            } else {
                None
            },
            comment: entry.comment.filter(|c| !c.is_empty()),
            availability: None,
            imported: true,
        });
    }

    if entry_count > 0 && flows.is_empty() {
        anyhow::bail!("HAR archive contains no usable request entries");
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
    parse_saz_budgeted(bytes, SAZ_TOTAL_BUDGET)
}

fn parse_saz_budgeted(bytes: &[u8], budget: u64) -> Result<Vec<Flow>> {
    parse_saz_limited(bytes, budget, crate::body::MAX_DECOMPRESSED_BYTES as u64)
}

fn parse_saz_limited(bytes: &[u8], budget: u64, member_budget: u64) -> Result<Vec<Flow>> {
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
        let is_client = caps[2].eq_ignore_ascii_case("c");
        let entry = zip.by_name(&name).map_err(|_| {
            anyhow::anyhow!("could not read '{name}' (encrypted SAZ is not supported)")
        })?;
        let mut buf = Vec::new();
        // Cap how much we inflate from a single zip member so a small crafted
        // archive can't expand to gigabytes (zip-bomb) and exhaust memory. Read
        // one byte beyond the remaining aggregate budget so an overrun is
        // detected without retaining an entire extra capped member.
        let remaining = budget.saturating_sub(total_bytes);
        let read_cap = member_budget
            .saturating_add(1)
            .min(remaining.saturating_add(1));
        if entry.take(read_cap).read_to_end(&mut buf).is_err() {
            sessions.remove(&n);
            tracing::warn!("could not inflate SAZ member '{name}'; session skipped");
            continue;
        }
        if (buf.len() as u64) > member_budget {
            sessions.remove(&n);
            tracing::warn!("SAZ member '{name}' exceeded {member_budget} bytes; session skipped");
            continue;
        }
        if (buf.len() as u64) > remaining {
            // If this was the second half of a session, do not turn its
            // already-buffered request into a misleading request-only flow.
            sessions.remove(&n);
            tracing::warn!("SAZ import exceeded {budget} bytes; remaining sessions skipped");
            break;
        }
        total_bytes = total_bytes.saturating_add(buf.len() as u64);
        let slot = sessions.entry(n).or_default();
        if is_client {
            slot.client = Some(buf);
        } else {
            slot.server = Some(buf);
        }
    }

    let mut flows = Vec::new();
    // The zip-layer total above only bounds what the archive itself inflates to;
    // bodies may additionally carry Content-Encoding (decoded per-body in
    // `decode_body`), so budget that decoded output too or a small archive of
    // many gzip-bomb bodies would expand to members x the per-body cap.
    let mut decoded_bytes: u64 = 0;
    for (_n, raw) in sessions {
        let Some(client) = raw.client else {
            continue;
        };
        let Ok(request) = parse_request(&client) else {
            continue; // skip unparseable sessions (e.g. odd CONNECT records)
        };
        let response = raw.server.as_deref().and_then(|s| parse_response(s).ok());
        let flow_bytes = (request.body.len() as u64).saturating_add(
            response
                .as_ref()
                .map_or(0, |response| response.body.len() as u64),
        );
        if decoded_bytes.saturating_add(flow_bytes) > budget {
            tracing::warn!(
                "SAZ import decoded more than {budget} bytes; remaining sessions skipped"
            );
            break;
        }
        decoded_bytes = decoded_bytes.saturating_add(flow_bytes);
        flows.push(Flow {
            id: String::new(),
            seq: 0,
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
    // A Fiddler SAZ stores the outer HTTPS CONNECT tunnel as its own session. Its
    // authority-form target (`host:443`) isn't a real URL, so reconstructing one
    // yields a mangled `https://hosthost:443` row — skip it (the decrypted
    // requests inside the tunnel are separate sessions of their own).
    if method.eq_ignore_ascii_case("CONNECT") {
        anyhow::bail!("skip CONNECT tunnel session");
    }
    let target = req.path.unwrap_or("/").to_string();
    let version = format!("HTTP/1.{}", req.version.unwrap_or(1));
    let mut headers = collect_headers(req.headers);
    let host_hdr = header_get(&headers, "host").unwrap_or_default();
    let body = decode_body(&mut headers, body);

    // Absolute-form (proxy) request lines carry the scheme; origin-form needs Host.
    let (scheme, host, path, uri) = if has_uri_scheme(&target) {
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
        body: body.into(),
        timestamp_ms: now_ms(),
    })
}

/// Absolute-form request targets start with an RFC-style URI scheme. Looking
/// for `://` anywhere is insufficient: an ordinary origin-form query such as
/// `/redirect?next=https://example.com` contains it too.
fn has_uri_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn parse_response(raw: &[u8]) -> Result<CapturedResponse> {
    let mut remaining = raw;
    loop {
        let (head, body) = split_head_body(remaining);
        let mut hbuf = [httparse::EMPTY_HEADER; 100];
        let mut res = httparse::Response::new(&mut hbuf);
        if res.parse(head)?.is_partial() {
            anyhow::bail!("incomplete response head");
        }
        let status = res.code.unwrap_or(0);
        // Fiddler can retain interim responses (most commonly 100 Continue)
        // before the final response in one `_s.txt`. Store the final exchange;
        // 101 is not interim here because it switches protocols.
        if (100..200).contains(&status) && status != 101 && body.starts_with(b"HTTP/") {
            remaining = body;
            continue;
        }
        let mut headers = collect_headers(res.headers);
        let body = decode_body(&mut headers, body);
        return Ok(CapturedResponse {
            status,
            version: format!("HTTP/1.{}", res.version.unwrap_or(1)),
            headers,
            body: body.into(),
            timestamp_ms: now_ms(),
        });
    }
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

fn transfer_encodings(headers: &[(String, String)]) -> Vec<String> {
    headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, value)| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// De-chunk (if chunked) then decompress (per Content-Encoding) a raw body,
/// removing framing/encoding headers only when their corresponding transform
/// completed. The stored headers must always describe the stored bytes: replay
/// and mock creation consume this same representation later.
fn decode_body(headers: &mut Vec<(String, String)>, body: &[u8]) -> Vec<u8> {
    let transfer_chain = transfer_encodings(headers);
    let (stage1, transfer_decoded) = if transfer_chain.is_empty() {
        (body.to_vec(), false)
    } else {
        // RFC transfer codings are undone in reverse and `chunked` must be the
        // final coding on the wire. Decode all-or-nothing: preserving a raw
        // `gzip, chunked` message is safer than dechunking it and then silently
        // dropping the still-required gzip label when that second step fails.
        let Some((last, preceding)) = transfer_chain.split_last() else {
            unreachable!("the non-empty transfer chain has a last element")
        };
        if last != "chunked" {
            return body.to_vec();
        }
        let Some(mut decoded) = dechunk(body) else {
            return body.to_vec();
        };
        for encoding in preceding
            .iter()
            .rev()
            .filter(|encoding| *encoding != "identity")
        {
            let Some((next, false)) = crate::body::try_decompress_checked(encoding, &decoded)
            else {
                return body.to_vec();
            };
            decoded = next;
        }
        (decoded, true)
    };
    let (body, content_decoded) = match crate::body::decode_body(headers, &stage1) {
        Some((decoded, false)) => (decoded, true),
        // Keep the exact compressed bytes when decoding hit its safety cap.
        // Storing the capped prefix as if it were the full identity body would
        // silently fabricate a truncated response while retaining the original
        // Content-Encoding header.
        Some((_partial, true)) => (stage1, false),
        None => (stage1, false),
    };
    if transfer_decoded || content_decoded {
        headers.retain(|(name, _)| {
            if transfer_decoded
                && (name.eq_ignore_ascii_case("transfer-encoding")
                    || name.eq_ignore_ascii_case("trailer"))
            {
                return false;
            }
            if content_decoded && name.eq_ignore_ascii_case("content-encoding") {
                return false;
            }
            !name.eq_ignore_ascii_case("content-length")
        });
    }
    body
}

fn dechunk(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let eol = find_sub(rest, b"\r\n")?;
        let hex = rest[..eol]
            .split(|&b| b == b';')
            .next()
            .unwrap_or(&rest[..eol]);
        let size = std::str::from_utf8(hex)
            .ok()
            .and_then(|s| usize::from_str_radix(s.trim(), 16).ok())?;
        let data_start = eol + 2;
        if size == 0 {
            // The last-chunk is followed by either the final CRLF or a trailer
            // section terminated by an empty line. Do not accept a truncated
            // `0\r\n`: that would erase the only raw copy despite the decoder's
            // all-or-nothing contract.
            let trailers = &rest[data_start..];
            if trailers == b"\r\n"
                || (!trailers.starts_with(b"\r\n")
                    && find_sub(trailers, b"\r\n\r\n").is_some_and(|end| end + 4 == trailers.len()))
            {
                return Some(out);
            }
            return None;
        }
        let data_end = data_start.checked_add(size)?;
        if data_end > rest.len() {
            return None;
        }
        out.extend_from_slice(&rest[data_start..data_end]);
        let terminator_end = data_end.checked_add(2)?;
        if rest.get(data_end..terminator_end) != Some(b"\r\n") {
            return None;
        }
        rest = &rest[terminator_end..];
    }
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
        assert_eq!(r0.body, b"{\"ok\":true}".as_slice());

        // base64 body decodes to "hi".
        assert_eq!(flows[1].response.as_ref().unwrap().body, b"hi".as_slice());
    }

    #[test]
    fn har_decoded_bodies_drop_stale_wire_encoding_and_length_headers() {
        let har = r#"{"log":{"entries":[{
          "request":{"method":"POST","url":"https://a/upload",
            "headers":[{"name":"Content-Encoding","value":"gzip"},{"name":"Content-Length","value":"20"}],
            "postData":{"text":"request identity"}},
          "response":{"status":200,
            "headers":[{"name":"Content-Encoding","value":"br"},{"name":"Content-Length","value":"9"},{"name":"X-Keep","value":"yes"}],
            "content":{"text":"response identity"}}
        }]}}"#;
        let flows = parse_har(har.as_bytes()).unwrap();
        let flow = &flows[0];
        assert_eq!(flow.request.body, b"request identity".as_slice());
        assert!(flow.request.headers.is_empty());
        let response = flow.response.as_ref().unwrap();
        assert_eq!(response.body, b"response identity".as_slice());
        assert_eq!(response.headers, vec![("X-Keep".into(), "yes".into())]);
    }

    #[test]
    fn germi_raw_har_body_retains_its_content_encoding() {
        let har = r#"{"log":{"entries":[{
          "request":{"url":"https://a/"},
          "response":{"status":200,
            "headers":[{"name":"Content-Encoding","value":"zstd"},{"name":"Content-Length","value":"3"}],
            "content":{"encoding":"base64","text":"AAEC","_germiBodyEncoded":true}}
        }]}}"#;
        let flow = parse_har(har.as_bytes()).unwrap().remove(0);
        let response = flow.response.unwrap();
        assert_eq!(response.body, [0, 1, 2].as_slice());
        assert_eq!(
            response.headers,
            vec![
                ("Content-Encoding".into(), "zstd".into()),
                ("Content-Length".into(), "3".into())
            ]
        );
    }

    #[test]
    fn tolerates_minimal_har() {
        let flows = parse_har(br#"{"log":{"entries":[]}}"#).unwrap();
        assert!(flows.is_empty());
    }

    #[test]
    fn rejects_json_that_is_not_structurally_a_har() {
        assert!(parse_har(br"{}").is_err());
        assert!(parse_har(br#"{"log":{}}"#).is_err());
        assert!(parse_har(br#"{"log":{"entries":[{}]}}"#).is_err());
    }

    #[test]
    fn preserves_explicit_zero_timings() {
        let har = r#"{"log":{"entries":[{
          "time":0,
          "timings":{"wait":0},
          "request":{"url":"https://a/"},
          "response":{"status":200,"headers":[],"content":{}}
        }]}}"#;
        let flows = parse_har(har.as_bytes()).expect("zero timings are valid HAR values");
        assert_eq!(flows[0].duration_ms, Some(0));
        assert_eq!(flows[0].ttfb_ms, Some(0));
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
        let flows =
            parse_har(har.as_bytes()).expect("a malformed status must not abort the import");
        assert_eq!(flows.len(), 3);
        // A fractional number and an integer outside u16 both fall back to 0.
        assert_eq!(flows[0].response.as_ref().unwrap().status, 0);
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
        assert_eq!(flows[0].response.as_ref().unwrap().body, b"hi".as_slice());
    }

    #[test]
    fn har_invalid_base64_marker_does_not_erase_the_only_body_copy() {
        let har = r#"{"log":{"entries":[
          {"request":{"url":"https://a/b","postData":{"encoding":"BASE64","text":"not@@base64"}},
           "response":{"status":200,"headers":[],
             "content":{"encoding":"base64","text":"also@@invalid"}}}
        ]}}"#;
        let flows = parse_har(har.as_bytes()).unwrap();
        assert_eq!(flows[0].request.body, b"not@@base64".as_slice());
        assert_eq!(
            flows[0].response.as_ref().unwrap().body,
            b"also@@invalid".as_slice()
        );
    }

    #[test]
    fn har_statusless_response_body_is_not_mistaken_for_an_unanswered_request() {
        let har = r#"{"log":{"entries":[{
          "request":{"url":"https://a/body-only"},
          "response":{"content":{"text":"the only response copy"}}
        }]}}"#;

        let flow = parse_har(har.as_bytes()).unwrap().remove(0);
        let response = flow
            .response
            .expect("a body proves a response was captured");
        assert_eq!(response.status, 0);
        assert_eq!(response.body, b"the only response copy".as_slice());
    }

    #[test]
    fn dechunks_body() {
        assert_eq!(
            dechunk(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"),
            Some(b"Wikipedia".to_vec())
        );
    }

    #[test]
    fn decodes_the_full_transfer_encoding_chain() {
        use std::io::Write;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(b"transfer-coded body").unwrap();
        let compressed = gzip.finish().unwrap();
        let chunked = format!("{:x}\r\n", compressed.len())
            .into_bytes()
            .into_iter()
            .chain(compressed)
            .chain(b"\r\n0\r\n\r\n".iter().copied())
            .collect::<Vec<_>>();
        let mut headers = vec![
            ("Transfer-Encoding".into(), "gzip, chunked".into()),
            ("Trailer".into(), "X-Checksum".into()),
            ("Content-Length".into(), chunked.len().to_string()),
            ("X-Keep".into(), "yes".into()),
        ];

        assert_eq!(decode_body(&mut headers, &chunked), b"transfer-coded body");
        assert_eq!(headers, vec![("X-Keep".into(), "yes".into())]);
    }

    #[test]
    fn unsupported_transfer_coding_preserves_the_exact_message() {
        let raw = b"4\r\nWiki\r\n0\r\n\r\n";
        let mut headers = vec![("Transfer-Encoding".into(), "snappy, chunked".into())];

        assert_eq!(decode_body(&mut headers, raw), raw);
        assert_eq!(
            headers,
            vec![("Transfer-Encoding".into(), "snappy, chunked".into())]
        );
    }

    #[test]
    fn malformed_later_chunk_preserves_the_raw_body() {
        let body = b"4\r\nWiki\r\nnot-hex\r\nrest";
        let mut headers = vec![("Transfer-Encoding".into(), "chunked".into())];
        assert_eq!(decode_body(&mut headers, body), body);
        assert_eq!(
            headers,
            vec![("Transfer-Encoding".into(), "chunked".into())]
        );
    }

    #[test]
    fn truncated_terminal_chunk_preserves_the_raw_body() {
        let body = b"4\r\nWiki\r\n0\r\n";
        let mut headers = vec![("Transfer-Encoding".into(), "chunked".into())];
        assert_eq!(decode_body(&mut headers, body), body);
        assert_eq!(
            headers,
            vec![("Transfer-Encoding".into(), "chunked".into())]
        );
    }

    #[test]
    fn origin_form_query_containing_a_url_keeps_its_real_host_and_path() {
        let request = parse_request(
            b"GET /redirect?next=https://other.test/path HTTP/1.1\r\nHost: source.test\r\n\r\n",
        )
        .expect("parse request");
        assert_eq!(request.scheme, "https");
        assert_eq!(request.host, "source.test");
        assert_eq!(request.path, "/redirect?next=https://other.test/path");
    }

    #[test]
    fn skips_interim_response_and_imports_the_final_exchange() {
        let response = parse_response(
            b"HTTP/1.1 100 Continue\r\nX-Interim: yes\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok",
        )
        .expect("parse response");
        assert_eq!(response.status, 201);
        assert_eq!(response.body, b"ok".as_slice());
        assert!(response
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("x-interim")));
    }

    #[test]
    fn parses_raw_request_and_response() {
        let req = b"POST /api/login HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\n\r\n{\"u\":1}";
        let r = parse_request(req).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.host, "api.test");
        assert_eq!(r.path, "/api/login");
        assert_eq!(r.uri, "https://api.test/api/login");
        assert_eq!(r.body, b"{\"u\":1}".as_slice());

        let res = b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope";
        let resp = parse_response(res).unwrap();
        assert_eq!(resp.status, 404);
        assert_eq!(resp.body, b"nope".as_slice());
    }

    /// Build an in-memory SAZ of `count` sessions whose response bodies are
    /// gzip Content-Encoded and each inflate to `inflated_len` bytes.
    fn saz_with_gzip_sessions(count: usize, inflated_len: usize) -> Vec<u8> {
        use std::io::Write;
        let opts = zip::write::SimpleFileOptions::default();
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for n in 1..=count {
            zw.start_file(format!("raw/{n}_c.txt"), opts).unwrap();
            zw.write_all(b"GET /big HTTP/1.1\r\nHost: api.test\r\n\r\n")
                .unwrap();
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&vec![b'a'; inflated_len]).unwrap();
            let gz = enc.finish().unwrap();
            zw.start_file(format!("raw/{n}_s.txt"), opts).unwrap();
            zw.write_all(b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n")
                .unwrap();
            zw.write_all(&gz).unwrap();
        }
        zw.finish().unwrap().into_inner()
    }

    fn saz_with_raw_members(members: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let opts = zip::write::SimpleFileOptions::default();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in members {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn saz_decoded_body_budget_truncates_sessions() {
        // Each gzip body is a few hundred bytes in the archive but inflates to
        // 100 KB; the archive-layer totals stay tiny, so only counting the
        // Content-Encoding-decoded output can stop this.
        let saz = saz_with_gzip_sessions(4, 100 * 1024);
        let flows = parse_saz_budgeted(&saz, 150 * 1024).unwrap();
        assert_eq!(flows.len(), 1, "the decoded-byte budget is never exceeded");
        assert_eq!(flows[0].response.as_ref().unwrap().body.len(), 100 * 1024);
    }

    #[test]
    fn oversized_zip_member_drops_only_its_session() {
        let request_one = b"GET /dropped HTTP/1.1\r\nHost: api.test\r\n\r\n";
        let mut oversized = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        oversized.extend_from_slice(&[b'x'; 128]);
        let request_two = b"GET /kept HTTP/1.1\r\nHost: api.test\r\n\r\n";
        let response_two = b"HTTP/1.1 200 OK\r\n\r\nok";
        let saz = saz_with_raw_members(&[
            ("raw/1_c.txt", request_one),
            ("raw/1_s.txt", &oversized),
            ("raw/2_c.txt", request_two),
            ("raw/2_s.txt", response_two),
        ]);

        let flows = parse_saz_limited(&saz, 4096, 96).expect("parse limited SAZ");
        assert_eq!(flows.len(), 1);
        assert_eq!(flows[0].request.path, "/kept");
    }

    #[test]
    fn aggregate_overrun_does_not_leave_a_partial_request_only_flow() {
        let request = b"GET /partial HTTP/1.1\r\nHost: api.test\r\n\r\n";
        let response = b"HTTP/1.1 200 OK\r\n\r\nbody";
        let saz = saz_with_raw_members(&[("raw/1_c.txt", request), ("raw/1_s.txt", response)]);
        let budget = (request.len() + response.len() - 1) as u64;

        let flows = parse_saz_limited(&saz, budget, 4096).expect("parse budgeted SAZ");
        assert!(flows.is_empty());
    }

    #[test]
    fn huge_har_duration_saturates_the_response_timestamp() {
        let har = r#"{"log":{"entries":[{
          "startedDateTime":"2026-01-01T00:00:00Z",
          "time":1e300,
          "request":{"url":"https://a/"},
          "response":{"status":200,"headers":[{"name":"x","value":"1"}],"content":{}}
        }]}}"#;
        let flows = parse_har(har.as_bytes()).expect("huge duration remains importable");
        assert_eq!(
            flows[0].response.as_ref().expect("response").timestamp_ms,
            u64::MAX
        );
    }

    #[test]
    fn saz_under_budget_decodes_every_session() {
        let saz = saz_with_gzip_sessions(4, 100 * 1024);
        let flows = parse_saz(&saz).unwrap();
        assert_eq!(flows.len(), 4);
        for f in &flows {
            assert_eq!(f.response.as_ref().unwrap().body, vec![b'a'; 100 * 1024]);
        }
    }

    #[test]
    fn decodes_chunked_gzip_response() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
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
        assert_eq!(resp.body, b"hello world".as_slice());
        assert!(resp.headers.iter().all(|(name, _)| {
            !name.eq_ignore_ascii_case("content-encoding")
                && !name.eq_ignore_ascii_case("transfer-encoding")
        }));
    }

    #[test]
    fn transfer_encoding_requires_an_exact_chunked_token() {
        let body = b"4\r\nWiki\r\n0\r\n\r\n";
        let mut headers = vec![("Transfer-Encoding".into(), "notchunked".into())];
        assert_eq!(decode_body(&mut headers, body), body);
        assert_eq!(
            headers,
            vec![("Transfer-Encoding".into(), "notchunked".into())]
        );
    }

    #[test]
    fn saz_body_decoding_undoes_the_full_content_encoding_chain() {
        use std::io::Write;
        let mut deflate =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        deflate.write_all(b"chained body").unwrap();
        let deflated = deflate.finish().unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&deflated).unwrap();
        let encoded = gzip.finish().unwrap();

        let mut headers = vec![("Content-Encoding".into(), "deflate, gzip".into())];
        assert_eq!(decode_body(&mut headers, &encoded), b"chained body");
        assert!(
            headers.is_empty(),
            "decoded bytes must not retain the encoding label"
        );
    }
}
