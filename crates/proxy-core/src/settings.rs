//! Proxy-wide settings. Currently: hosts to exclude from interception.

use serde::{Deserialize, Serialize};

/// User-configurable proxy settings, persisted by the shell.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    /// Host patterns to bypass entirely. A matching HTTPS `CONNECT` is tunneled
    /// straight through without MITM — no certificate, no decryption, no
    /// capture — and a matching plain-HTTP request is forwarded unrecorded.
    /// A pattern matches the host itself and all its subdomains, so
    /// `spotify.com` also excludes `api.spotify.com`.
    #[serde(default)]
    pub excluded_hosts: Vec<String>,
}

impl ProxySettings {
    /// Whether `host` should bypass interception.
    pub fn is_excluded(&self, host: &str) -> bool {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        self.excluded_hosts.iter().any(|p| host_matches(&host, p))
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
    fn tolerates_wildcard_and_blank_patterns() {
        let s = settings(&["*.google.com", "  ", ""]);
        assert!(s.is_excluded("mail.google.com"));
        assert!(s.is_excluded("google.com"));
        assert!(!s.is_excluded("example.org"));
    }
}
