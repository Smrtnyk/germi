//! Shared HTTP body decoding (Content-Encoding) used both when importing SAZ
//! and when displaying live-captured bodies in the inspector.

use std::io::Read;

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
    fn read_all(mut r: impl Read) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        r.read_to_end(&mut out).ok().map(|_| out)
    }
    if encoding.contains("gzip") {
        read_all(flate2::read::GzDecoder::new(body))
    } else if encoding.contains("deflate") {
        read_all(flate2::read::ZlibDecoder::new(body))
            .or_else(|| read_all(flate2::read::DeflateDecoder::new(body)))
    } else if encoding.contains("br") {
        read_all(brotli::Decompressor::new(body, 4096))
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
    fn picks_first_encoding_token() {
        let h = vec![("Content-Encoding".to_string(), "br, gzip".to_string())];
        assert_eq!(content_encoding_of(&h).as_deref(), Some("br"));
        let none = vec![("Content-Encoding".to_string(), "identity".to_string())];
        assert_eq!(content_encoding_of(&none), None);
    }
}
