//! Shared HTTP body decoding (Content-Encoding) used both when importing SAZ
//! and when displaying live-captured bodies in the inspector.

use std::io::Read;
use std::sync::LazyLock;

/// Decode standard base64 leniently: tolerate ASCII whitespace / line wraps and
/// missing padding (some tools emit either), so a reformatted SAZ/HAR/session
/// body still loads. Returns `None` only on genuinely-invalid input.
pub fn base64_lenient(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    static ENGINE: LazyLock<base64::engine::GeneralPurpose> = LazyLock::new(|| {
        base64::engine::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
        )
    });
    let cleaned: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    ENGINE.decode(&cleaned).ok()
}

/// Hard ceiling on the size of any single *decompressed* body. A compression
/// bomb (a few KB inflating to gigabytes) is capped here so import / inspector
/// display / body-search can't be driven into OOM by hostile input. Generous
/// enough that real debugging bodies are unaffected (the inspector additionally
/// caps *display* at 512 KB); output is truncated at this bound, not rejected.
pub const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;

/// The first non-identity `Content-Encoding` token, lowercased (e.g. "gzip").
/// Informational only (the inspector's encoding label); use [`content_encodings_of`]
/// + [`decode_body`] to actually decode, which handles the full chain in order.
pub fn content_encoding_of(headers: &[(String, String)]) -> Option<String> {
    content_encodings_of(headers).into_iter().next()
}

/// Every non-identity `Content-Encoding` token, lowercased, in header order
/// (the order the encodings were *applied*). To decode, undo them in reverse.
pub fn content_encodings_of(headers: &[(String, String)]) -> Vec<String> {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-encoding"))
        .flat_map(|(_, v)| v.split(','))
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e != "identity")
        .collect()
}

/// Heuristic: do `bytes` look like human-readable text rather than binary?
///
/// Used to recognize a body that declares a `Content-Encoding` but isn't actually
/// compressed (a stale or incorrect header — seen from some servers, CDNs, and
/// proxy hops). Real compressed data is high-entropy and effectively never valid
/// UTF-8, so it reliably fails this check; readable text passes, and the
/// inspector can then show it as text instead of a decode "failure".
pub(crate) fn looks_textual(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let n = bytes.len().min(8192);
    let sample = &bytes[..n];
    let valid_up_to = match std::str::from_utf8(sample) {
        Ok(_) => n,
        // Tolerate only a trailing partial multi-byte char clipped by the sample
        // boundary; any earlier invalid byte means this isn't text.
        Err(e) if e.valid_up_to() >= n.saturating_sub(3) => e.valid_up_to(),
        Err(_) => return false,
    };
    let Ok(text) = std::str::from_utf8(&sample[..valid_up_to]) else {
        return false;
    };
    let mut total = 0usize;
    let mut ctrl = 0usize;
    for c in text.chars() {
        total += 1;
        if c.is_control() && !matches!(c, '\t' | '\n' | '\r') {
            ctrl += 1;
        }
    }
    // Mostly printable (<2% control chars) on top of a valid-UTF-8 prefix.
    total > 0 && ctrl * 50 < total
}

/// Decode the full `Content-Encoding` chain of a message body, undoing each
/// applied encoding in reverse (last-applied = outermost). Returns the decoded
/// bytes and whether the decompression cap truncated the result, or `None` when
/// there is no encoding or a layer fails to decode (callers fall back to raw).
pub fn decode_body(headers: &[(String, String)], body: &[u8]) -> Option<(Vec<u8>, bool)> {
    let chain = content_encodings_of(headers);
    if chain.is_empty() {
        return None;
    }
    let mut data = body.to_vec();
    let mut truncated = false;
    for enc in chain.iter().rev() {
        let (decoded, t) = try_decompress_checked(enc, &data)?;
        data = decoded;
        if t {
            // A truncated layer means the inner layers can't be decoded
            // faithfully; stop and report the partial result as truncated.
            truncated = true;
            break;
        }
    }
    Some((data, truncated))
}

/// A message body in its decoded form when a `Content-Encoding` chain decodes,
/// borrowing the raw bytes otherwise (identity bodies allocate nothing).
pub(crate) fn decoded_or_raw<'m>(
    headers: &[(String, String)],
    body: &'m [u8],
) -> std::borrow::Cow<'m, [u8]> {
    match decode_body(headers, body) {
        Some((decoded, _truncated)) => std::borrow::Cow::Owned(decoded),
        None => std::borrow::Cow::Borrowed(body),
    }
}

/// Decompress `body` per `encoding` (gzip / deflate / br). Returns `None` if the
/// encoding is unknown or decompression fails (e.g. the body isn't actually
/// compressed) — callers fall back to the raw bytes. Output is truncated to
/// [`MAX_DECOMPRESSED_BYTES`] (see [`try_decompress_checked`] to detect that).
pub fn try_decompress(encoding: &str, body: &[u8]) -> Option<Vec<u8>> {
    try_decompress_checked(encoding, body).map(|(b, _)| b)
}

/// Like [`try_decompress`] but also reports whether the output hit the
/// decompression cap (and was therefore truncated).
pub fn try_decompress_checked(encoding: &str, body: &[u8]) -> Option<(Vec<u8>, bool)> {
    try_decompress_capped(encoding, body, MAX_DECOMPRESSED_BYTES)
}

/// Decompress with an explicit output cap. Output exceeding `cap` is truncated
/// to `cap` rather than allocated in full, so a decompression bomb cannot
/// exhaust memory; the returned bool is `true` when truncation occurred.
fn try_decompress_capped(encoding: &str, body: &[u8], cap: usize) -> Option<(Vec<u8>, bool)> {
    fn read_all(r: impl Read, cap: usize) -> Option<(Vec<u8>, bool)> {
        let mut out = Vec::new();
        // Pull at most cap+1 bytes: `take` bounds a hostile payload that would
        // inflate to gigabytes, and the extra byte lets us detect truncation.
        r.take(cap as u64 + 1).read_to_end(&mut out).ok()?;
        let truncated = out.len() > cap;
        if truncated {
            out.truncate(cap);
        }
        Some((out, truncated))
    }
    if encoding.contains("gzip") {
        // MultiGzDecoder reads every concatenated member, not just the first.
        read_all(flate2::read::MultiGzDecoder::new(body), cap)
    } else if encoding.contains("deflate") {
        read_all(flate2::read::ZlibDecoder::new(body), cap)
            .or_else(|| read_all(flate2::read::DeflateDecoder::new(body), cap))
    } else if encoding.contains("br") {
        read_all(brotli::Decompressor::new(body, 4096), cap)
    } else {
        None
    }
}

/// Encode (compress) `body` with the single given `Content-Encoding` token. The
/// inverse of [`try_decompress`]: used by the autoresponder to re-compress a
/// mock body on the wire when a rule opts into a compressed response. Returns
/// `None` for an unknown encoding (callers send the identity body instead).
///
/// Only single-token encodings are supported (`gzip` / `deflate` / `br`), not
/// arbitrary chains — that matches real-world `Content-Encoding` usage and the
/// autoresponder's single-toggle model. Accepts the same lenient token matching
/// as `try_decompress` (e.g. `x-gzip` works).
pub fn compress_body(encoding: &str, body: &[u8]) -> Option<Vec<u8>> {
    use std::io::Write;
    if encoding.contains("gzip") {
        // GzEncoder produces a single-member stream; MultiGzDecoder reads it
        // back, so the round-trip matches the public decompress path.
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(body).ok()?;
        enc.finish().ok()
    } else if encoding.contains("deflate") {
        // Zlib (RFC 1950) — the deflate-with-zlib-wrapper variant servers send.
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(body).ok()?;
        enc.finish().ok()
    } else if encoding.contains("br") {
        let mut out = Vec::new();
        // Quality 5 / window 22 mirror the decompressor's read window and keep
        // encoding fast for interactive mock editing.
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(body).ok()?;
            w.flush().ok()?;
        }
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn gzip_round_trips() {
        let mut enc =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"hello body").unwrap();
        let gz = enc.finish().unwrap();
        assert_eq!(try_decompress("gzip", &gz).unwrap(), b"hello body");
    }

    #[test]
    fn non_compressed_returns_none() {
        assert!(try_decompress("gzip", b"not gzip").is_none());
        assert!(try_decompress("identity", b"plain").is_none());
    }

    #[test]
    fn decompression_is_capped() {
        // A highly compressible payload that decompresses to far more than the
        // (test) cap must be truncated to the cap, never allocated in full.
        let mut enc =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&vec![b'A'; 100_000]).unwrap();
        let gz = enc.finish().unwrap();
        assert!(gz.len() < 1_000, "payload should compress tiny");
        let (out, truncated) = try_decompress_capped("gzip", &gz, 4096).unwrap();
        assert_eq!(out.len(), 4096, "decompressed output is capped");
        assert!(truncated, "hitting the cap is reported as truncation");
        // The full (uncapped public API) decompresses everything, untruncated.
        let (full, t) = try_decompress_checked("gzip", &gz).unwrap();
        assert_eq!(full.len(), 100_000);
        assert!(!t, "within the cap is not truncated");
    }

    #[test]
    fn multi_member_gzip_is_fully_decoded() {
        // Two concatenated gzip members must both decode (not just the first).
        let member = |s: &[u8]| {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(s).unwrap();
            e.finish().unwrap()
        };
        let mut concat = member(b"hello ");
        concat.extend_from_slice(&member(b"world"));
        assert_eq!(try_decompress("gzip", &concat).unwrap(), b"hello world");
    }

    #[test]
    fn decode_body_undoes_chained_encodings() {
        // Content-Encoding: deflate, gzip => deflate applied first, gzip last;
        // decode reverses (undo gzip, then deflate) to recover the original.
        let mut def = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        def.write_all(b"chained body").unwrap();
        let deflated = def.finish().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&deflated).unwrap();
        let both = gz.finish().unwrap();

        let headers = vec![("Content-Encoding".to_string(), "deflate, gzip".to_string())];
        let (decoded, truncated) = decode_body(&headers, &both).unwrap();
        assert_eq!(decoded, b"chained body");
        assert!(!truncated);
        // No content-encoding => nothing to decode.
        assert!(decode_body(&[], b"plain").is_none());
    }

    #[test]
    fn looks_textual_separates_text_from_compressed() {
        assert!(looks_textual(b""));
        assert!(looks_textual(b"{\"ok\":true}\nplain text"));
        assert!(looks_textual("hello unicode \u{2713} \u{e9}".as_bytes()));
        // Real compressed payloads must read as binary (so a genuine decode
        // failure still shows as hex, not mislabeled text).
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b"the quick brown fox jumps over the lazy dog").unwrap();
        assert!(!looks_textual(&e.finish().unwrap()));
        assert!(!looks_textual(&[0x00, 0xff, 0xfe, 0x80, 0x01, 0x02, 0x9c, 0x8b]));
    }

    #[test]
    fn encoding_tokens() {
        let h = vec![("Content-Encoding".to_string(), "br, gzip".to_string())];
        assert_eq!(content_encoding_of(&h).as_deref(), Some("br"));
        assert_eq!(content_encodings_of(&h), vec!["br".to_string(), "gzip".to_string()]);
        let none = vec![("Content-Encoding".to_string(), "identity".to_string())];
        assert_eq!(content_encoding_of(&none), None);
        assert!(content_encodings_of(&none).is_empty());
    }

    #[test]
    fn compress_body_round_trips_each_encoding() {
        // Repetitive enough that every encoder's overhead is dwarfed; tiny
        // payloads can round-trip but not always shrink (gzip header alone is
        // ~18 bytes), so we don't assert size on those.
        let payload = b"{\"hello\":\"world\",\"items\":[1,2,3]}\n".repeat(40);
        for enc in ["gzip", "deflate", "br"] {
            let compressed = compress_body(enc, &payload)
                .unwrap_or_else(|| panic!("compress_body({enc}) should produce output"));
            assert!(
                compressed.len() < payload.len(),
                "{enc} output should be smaller for a repetitive payload"
            );
            let back = try_decompress(enc, &compressed)
                .unwrap_or_else(|| panic!("round-trip decompress {enc} must succeed"));
            assert_eq!(back, payload, "{enc} round-trip must be lossless");
        }
    }

    #[test]
    fn compress_body_unknown_encoding_returns_none() {
        assert!(compress_body("identity", b"abc").is_none());
        assert!(compress_body("snappy", b"abc").is_none());
    }

    #[test]
    fn compress_body_empty_is_supported() {
        // An empty mock body must round-trip, not error — important since the
        // default respond-rule body could legitimately be empty.
        for enc in ["gzip", "deflate", "br"] {
            let compressed = compress_body(enc, b"").expect("empty compresses");
            let back = try_decompress(enc, &compressed).expect("empty decompresses");
            assert!(back.is_empty(), "{enc} empty round-trip yields empty");
        }
    }
}
