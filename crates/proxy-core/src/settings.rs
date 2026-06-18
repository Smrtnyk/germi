//! Proxy-wide settings. Currently: hosts to exclude from interception.

use serde::{Deserialize, Serialize};

/// User-configurable proxy settings, persisted by the shell.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    /// Host patterns to bypass entirely. A matching HTTPS `CONNECT` is tunneled
    /// straight through without MITM — no certificate, no decryption, no
    /// capture — and a matching plain-HTTP request is forwarded unrecorded.
    /// A pattern matches the host itself and all its subdomains, so
    /// `spotify.com` also excludes `api.spotify.com`.
    #[serde(default)]
    pub excluded_hosts: Vec<String>,

    /// Header-column specs the user pinned to the traffic list. Each is a header
    /// name read from the response, or `req:<name>` for the request side. The
    /// engine extracts these into each row's `extra` map (see
    /// `extract_header_columns`) so they ride the existing summary stream.
    #[serde(default)]
    pub header_columns: Vec<String>,

    // ---- Connections ----
    /// Default listen port (remembered across launches).
    #[serde(default = "default_port")]
    pub port: u16,
    /// Bind `0.0.0.0` instead of `127.0.0.1` so other devices can use the proxy.
    #[serde(default)]
    pub allow_remote: bool,

    // ---- Capture ----
    /// Max flows retained in memory before the oldest are evicted.
    #[serde(default = "default_max_flows")]
    pub max_flows: usize,
    /// Host include-filter: when non-empty, only matching hosts are intercepted
    /// + recorded (others are tunneled). Same subdomain matching as exclusions.
    #[serde(default)]
    pub capture_filter: Vec<String>,
    /// Start the proxy automatically when the app launches.
    #[serde(default)]
    pub capture_on_start: bool,

    // ---- Throttling ----
    /// Artificial delay (ms) added before each response is returned (0 = off).
    #[serde(default)]
    pub response_delay_ms: u64,
}

fn default_port() -> u16 {
    8080
}
fn default_max_flows() -> usize {
    5_000
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            excluded_hosts: Vec::new(),
            header_columns: Vec::new(),
            port: default_port(),
            allow_remote: false,
            max_flows: default_max_flows(),
            capture_filter: Vec::new(),
            capture_on_start: false,
            response_delay_ms: 0,
        }
    }
}

impl ProxySettings {
    /// Whether `host` should bypass interception (excluded, or filtered out).
    pub fn is_excluded(&self, host: &str) -> bool {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        self.excluded_hosts.iter().any(|p| host_matches(&host, p))
    }

    /// Whether `host` passes the capture include-filter (empty filter = all pass).
    pub fn matches_capture_filter(&self, host: &str) -> bool {
        if self.capture_filter.is_empty() {
            return true;
        }
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        self.capture_filter.iter().any(|p| host_matches(&host, p))
    }
}

/// `host` matches `pattern` when equal to it or a subdomain of it. Tolerates a
/// leading `*.`, trailing dot, and surrounding whitespace in the pattern.
fn host_matches(host: &str, pattern: &str) -> bool {
    let pat = pattern
        .trim()
        .trim_start_matches("*.")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if pat.is_empty() {
        return false;
    }
    host == pat || host.ends_with(&format!(".{pat}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(hosts: &[&str]) -> ProxySettings {
        ProxySettings {
            excluded_hosts: hosts.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn matches_host_and_subdomains_case_insensitively() {
        let s = settings(&["spotify.com", "youtube.com"]);
        assert!(s.is_excluded("spotify.com"));
        assert!(s.is_excluded("api.spotify.com"));
        assert!(s.is_excluded("AUDIO.SPOTIFY.COM"));
        assert!(s.is_excluded("www.youtube.com"));
    }

    #[test]
    fn does_not_match_lookalikes() {
        let s = settings(&["spotify.com"]);
        assert!(!s.is_excluded("notspotify.com"));
        assert!(!s.is_excluded("spotify.com.evil.com"));
        assert!(!s.is_excluded("example.com"));
        assert!(!s.is_excluded(""));
    }

    #[test]
    fn capture_filter_includes_only_matching() {
        let mut s = settings(&[]);
        assert!(s.matches_capture_filter("anything.com")); // empty filter = all pass
        s.capture_filter = vec!["example.com".into()];
        assert!(s.matches_capture_filter("example.com"));
        assert!(s.matches_capture_filter("api.example.com"));
        assert!(!s.matches_capture_filter("other.com"));
    }

    #[test]
    fn tolerates_wildcard_and_blank_patterns() {
        let s = settings(&["*.google.com", "  ", ""]);
        assert!(s.is_excluded("mail.google.com"));
        assert!(s.is_excluded("google.com"));
        assert!(!s.is_excluded("example.org"));
    }
}
