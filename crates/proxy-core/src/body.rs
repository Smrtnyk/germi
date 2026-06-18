//! Shared HTTP body decoding (Content-Encoding) used both when importing SAZ
//! and when displaying live-captured bodies in the inspector.

use std::io::Read;

/// Hard ceiling on the size of any single *decompressed* body. A compression
/// bomb (a few KB inflating to gigabytes) is capped here so import / inspector
/// display / body-search can't be driven into OOM by hostile input. Generous
/// enough that real debugging bodies are unaffected (the inspector additionally
/// caps *display* at 512 KB); output is truncated at this bound, not rejected.
pub const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;

/// The first non-identity `Content-Encoding` token, lowercased (e.g. "gzip").
pub fn content_encoding_of(headers: &[(String, String)]) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-encoding"))
        .map(|(_, v)| {
            v.split(',')
                .next()
                .unwrap_or(v)
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|e| !e.is_empty() && e != "identity")
}

/// Decompress `body` per `encoding` (gzip / deflate / br). Returns `None` if the
/// encoding is unknown or decompression fails (e.g. the body isn't actually
/// compressed) — callers fall back to the raw bytes.
pub fn try_decompress(encoding: &str, body: &[u8]) -> Option<Vec<u8>> {
    try_decompress_capped(encoding, body, MAX_DECOMPRESSED_BYTES)
}

/// Decompress with an explicit output cap (the public entry point uses
/// [`MAX_DECOMPRESSED_BYTES`]). Output exceeding `cap` is truncated to `cap`
/// rather than allocated in full, so a decompression bomb cannot exhaust memory.
fn try_decompress_capped(encoding: &str, body: &[u8], cap: usize) -> Option<Vec<u8>> {
    fn read_all(r: impl Read, cap: usize) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        // `take` bounds how much we pull out of the decoder, so a tiny hostile
        // payload that would inflate to gigabytes stops at `cap` bytes.
        r.take(cap as u64).read_to_end(&mut out).ok().map(|_| out)
    }
    if encoding.contains("gzip") {
        read_all(flate2::read::GzDecoder::new(body), cap)
    } else if encoding.contains("deflate") {
        read_all(flate2::read::ZlibDecoder::new(body), cap)
            .or_else(|| read_all(flate2::read::DeflateDecoder::new(body), cap))
    } else if encoding.contains("br") {
        read_all(brotli::Decompressor::new(body, 4096), cap)
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
        let out = try_decompress_capped("gzip", &gz, 4096).unwrap();
        assert_eq!(out.len(), 4096, "decompressed output is capped");
        // The full (uncapped public API) decompresses everything.
        assert_eq!(try_decompress("gzip", &gz).unwrap().len(), 100_000);
    }

    #[test]
    fn picks_first_encoding_token() {
        let h = vec![("Content-Encoding".to_string(), "br, gzip".to_string())];
        assert_eq!(content_encoding_of(&h).as_deref(), Some("br"));
        let none = vec![("Content-Encoding".to_string(), "identity".to_string())];
        assert_eq!(content_encoding_of(&none), None);
    }
}
