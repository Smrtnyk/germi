//! Proxy-wide settings. Currently: hosts to exclude from interception.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::ops::Deref;

pub const FILTER_COLOR_PRESET_COUNT: usize = 10;
const DEFAULT_FILTER_COLOR_PRESETS_JSON: &str = include_str!("../../../filter-color-presets.json");

/// Ten complete filter tints, serialized as normalized `#rrggbbaa` strings.
/// The fixed-size wrapper makes an invalid settings file unable to leak a
/// short or oversized palette into any frontend window.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(transparent)]
pub struct FilterColorPresets([String; FILTER_COLOR_PRESET_COUNT]);

impl FilterColorPresets {
    fn default_values() -> [String; FILTER_COLOR_PRESET_COUNT] {
        let values: Vec<String> = serde_json::from_str(DEFAULT_FILTER_COLOR_PRESETS_JSON)
            .expect("the bundled filter-color preset palette must be valid JSON");
        let values: [String; FILTER_COLOR_PRESET_COUNT] = values
            .try_into()
            .expect("the bundled filter-color preset palette must contain exactly ten entries");
        std::array::from_fn(|index| {
            normalize_filter_color_preset(&values[index], "")
                .expect("each bundled filter-color preset must be a complete valid #rrggbbaa tint")
        })
    }
}

impl Default for FilterColorPresets {
    fn default() -> Self {
        Self(Self::default_values())
    }
}

impl Deref for FilterColorPresets {
    type Target = [String; FILTER_COLOR_PRESET_COUNT];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Match the frontend picker's `Math.round(alpha * 100 / 255)` conversion.
fn alpha_byte_to_percent(alpha: u8) -> u8 {
    ((u16::from(alpha) * 100 + 127) / 255) as u8
}

/// Match the frontend picker's `Math.round(percent * 255 / 100)` conversion.
fn alpha_percent_to_byte(alpha_percent: u8) -> u8 {
    ((u16::from(alpha_percent) * 255 + 50) / 100) as u8
}

fn normalize_filter_color_preset(value: &str, fallback: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let digits = normalized.strip_prefix('#')?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        8 => {
            // Persist only bytes the whole-percent picker can represent, so a
            // settings load followed by splitHex8/joinHex8 is stable.
            let alpha = u8::from_str_radix(&digits[6..8], 16).ok()?;
            let canonical_alpha = alpha_percent_to_byte(alpha_byte_to_percent(alpha));
            Some(format!("#{}{canonical_alpha:02x}", &digits[..6]))
        }
        // A hue-only legacy value keeps this slot's deliberately usable alpha.
        6 => Some(format!("#{digits}{}", fallback.get(7..9)?)),
        _ => None,
    }
}

impl<'de> Deserialize<'de> for FilterColorPresets {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(deserializer)?;
        let incoming = raw.as_array();
        let defaults = Self::default_values();
        Ok(Self(std::array::from_fn(|index| {
            incoming
                .and_then(|values| values.get(index))
                .and_then(serde_json::Value::as_str)
                .and_then(|value| normalize_filter_color_preset(value, &defaults[index]))
                .unwrap_or_else(|| defaults[index].clone())
        })))
    }
}

/// User-selected application color preference. Legacy settings without this
/// field follow the operating system, matching the first-run UI default.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorTheme {
    #[default]
    System,
    Dark,
    Light,
}

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
    #[serde(
        default = "default_max_flows",
        deserialize_with = "deserialize_max_flows"
    )]
    pub max_flows: usize,
    /// Host include-filter: when non-empty, only matching hosts are intercepted
    /// + recorded (others are tunneled). Same subdomain matching as exclusions.
    #[serde(default)]
    pub capture_filter: Vec<String>,
    /// Start the proxy automatically when the app launches (default on).
    #[serde(default = "default_true")]
    pub auto_start_on_launch: bool,

    // ---- Throttling ----
    /// Artificial delay (ms) added before each response is returned (0 = off).
    #[serde(default)]
    pub response_delay_ms: u64,

    // ---- Shortcuts ----
    /// Global hotkey (Tauri accelerator, e.g. `CmdOrCtrl+Shift+P`) that toggles
    /// the OS system proxy on/off. Empty = unset. Registered by the shell, not
    /// the engine; stored here so it persists with the rest of the settings.
    #[serde(default)]
    pub system_proxy_hotkey: String,

    // ---- Appearance ----
    /// Application color theme, shared by every webview window.
    #[serde(default)]
    pub theme: ColorTheme,
    /// Highlight-color overrides for the UI, keyed by a semantic name the
    /// frontend defines (see `src/theme.ts`), values `#rrggbbaa`. Sparse —
    /// absent keys mean the stylesheet default. The engine never interprets
    /// these; they live here so they persist and ride settings import/export
    /// with everything else (issue #93).
    #[serde(default)]
    pub highlight_colors: BTreeMap<String, String>,
    /// Ten user-editable saved-filter presets. Each value carries hue and alpha
    /// so choosing a preset is a complete, one-step tint choice.
    #[serde(default)]
    pub filter_color_presets: FilterColorPresets,
}

fn default_port() -> u16 {
    8080
}
fn default_max_flows() -> usize {
    5_000
}
fn deserialize_max_flows<'de, D: Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    // FlowStore has the same lower bound. Normalize at the serde boundary so a
    // hand-edited/imported zero cannot be persisted and shown in the UI while
    // the runtime silently retains one flow instead.
    Ok(usize::deserialize(deserializer)?.max(1))
}
fn default_true() -> bool {
    true
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
            auto_start_on_launch: true,
            response_delay_ms: 0,
            system_proxy_hotkey: String::new(),
            theme: ColorTheme::default(),
            highlight_colors: BTreeMap::new(),
            filter_color_presets: FilterColorPresets::default(),
        }
    }
}

impl ProxySettings {
    /// Whether `host` should bypass interception (excluded, or filtered out).
    pub fn is_excluded(&self, host: &str) -> bool {
        let host = normalize_host(host);
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
        let host = normalize_host(host);
        self.capture_filter.iter().any(|p| host_matches(&host, p))
    }
}

/// Normalize an incoming host for matching: strip any `:port` suffix (the Host
/// header carries one for non-default ports, e.g. `example.com:8080`), the
/// trailing dot, and case. Without this, an excluded/filtered host would be
/// bypassed for plain-HTTP requests to a non-standard port.
fn normalize_host(host: &str) -> String {
    strip_port(host.trim())
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Drop a trailing `:port`. Handles bracketed IPv6 literals (`[::1]:8080` →
/// `::1`) and leaves a bare IPv6 address (`::1`, which has no port) intact.
fn strip_port(host: &str) -> &str {
    if host.starts_with('[') {
        return match host.find(']') {
            Some(end) => &host[1..end],
            None => host,
        };
    }
    match host.rsplit_once(':') {
        Some((name, port))
            if !name.contains(':')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            name
        }
        _ => host,
    }
}

/// `host` matches `pattern` when equal to it or a subdomain of it. Tolerates a
/// single leading `*.`, a `:port` suffix, bracketed IPv6 (`[::1]`), trailing
/// dot, and surrounding whitespace in the pattern — normalized the same way as
/// the incoming host so a port/bracketed pattern still matches.
fn host_matches(host: &str, pattern: &str) -> bool {
    let trimmed = pattern.trim();
    let without_wildcard = trimmed.strip_prefix("*.").unwrap_or(trimmed);
    let pat = strip_port(without_wildcard)
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
    fn strips_port_before_matching() {
        let s = settings(&["example.com"]);
        // A Host header with a port must still match the exclusion.
        assert!(s.is_excluded("example.com:8080"));
        assert!(s.is_excluded("api.example.com:443"));
        assert!(!s.is_excluded("other.com:8080"));

        let mut c = settings(&[]);
        c.capture_filter = vec!["example.com".into()];
        assert!(c.matches_capture_filter("example.com:8080"));
        assert!(!c.matches_capture_filter("other.com:8080"));
    }

    #[test]
    fn strip_port_handles_ipv6() {
        // Bracketed literal with a port normalizes to the bare address; a bare
        // IPv6 (no port) is left intact.
        assert_eq!(strip_port("[::1]:8080"), "::1");
        assert_eq!(strip_port("[::1]"), "::1");
        assert_eq!(strip_port("::1"), "::1");
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("example.com:8080"), "example.com");
    }

    #[test]
    fn tolerates_wildcard_and_blank_patterns() {
        let s = settings(&["*.google.com", "  ", ""]);
        assert!(s.is_excluded("mail.google.com"));
        assert!(s.is_excluded("google.com"));
        assert!(!s.is_excluded("example.org"));
    }

    #[test]
    fn pattern_with_port_and_brackets_is_normalized() {
        // A pattern carrying a :port still matches the (port-stripped) host.
        let s = settings(&["localhost:3000"]);
        assert!(s.is_excluded("localhost"));
        assert!(s.is_excluded("localhost:3000"));
        // A bracketed IPv6 pattern matches the bracketless normalized host.
        let v6 = settings(&["[::1]:8080"]);
        assert!(v6.is_excluded("[::1]:8080"));
        assert!(v6.is_excluded("::1"));
    }

    #[test]
    fn system_proxy_hotkey_serializes_camel_case_and_defaults_empty() {
        let s = ProxySettings {
            system_proxy_hotkey: "CmdOrCtrl+Shift+P".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).expect("serialize settings");
        assert!(json.contains("\"systemProxyHotkey\":\"CmdOrCtrl+Shift+P\""));

        // A settings.json written before this field existed must still load.
        let legacy: ProxySettings = serde_json::from_str("{}").expect("load legacy settings");
        assert_eq!(legacy.system_proxy_hotkey, "");

        let back: ProxySettings = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(back.system_proxy_hotkey, "CmdOrCtrl+Shift+P");
    }

    #[test]
    fn auto_start_on_launch_defaults_on_and_round_trips() {
        // A settings.json written before this field existed (or before it was
        // renamed away from `captureOnStart`) must load with auto-start ON, so
        // existing installs pick up the new default rather than staying off.
        let legacy: ProxySettings = serde_json::from_str("{}").expect("load legacy settings");
        assert!(legacy.auto_start_on_launch);
        assert!(ProxySettings::default().auto_start_on_launch);

        // camelCase mirror for the TS DTO, and an explicit false is preserved.
        let json = serde_json::to_string(&ProxySettings::default()).expect("serialize");
        assert!(json.contains("\"autoStartOnLaunch\":true"));
        let off: ProxySettings =
            serde_json::from_str("{\"autoStartOnLaunch\":false}").expect("load explicit off");
        assert!(!off.auto_start_on_launch);
    }

    #[test]
    fn zero_max_flows_normalizes_to_the_runtime_minimum() {
        let settings: ProxySettings =
            serde_json::from_str(r#"{"maxFlows":0}"#).expect("load settings");
        assert_eq!(settings.max_flows, 1);
    }

    #[test]
    fn highlight_colors_default_empty_and_round_trip() {
        // A settings.json written before this field existed must still load,
        // with no overrides (all stylesheet defaults).
        let legacy: ProxySettings = serde_json::from_str("{}").expect("load legacy settings");
        assert!(legacy.highlight_colors.is_empty());

        // camelCase mirror for the TS DTO, and entries survive a round-trip.
        let mut s = ProxySettings::default();
        s.highlight_colors
            .insert("selected".to_string(), "#173a36ff".to_string());
        let json = serde_json::to_string(&s).expect("serialize settings");
        assert!(json.contains("\"highlightColors\":{\"selected\":\"#173a36ff\"}"));
        let back: ProxySettings = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(
            back.highlight_colors.get("selected").map(String::as_str),
            Some("#173a36ff")
        );
    }

    #[test]
    fn filter_color_presets_default_and_round_trip_as_ten_normalized_tints() {
        let defaults = FilterColorPresets::default();
        let bundled: Vec<String> = serde_json::from_str(DEFAULT_FILTER_COLOR_PRESETS_JSON)
            .expect("parse bundled defaults in contract test");
        assert_eq!(defaults.len(), FILTER_COLOR_PRESET_COUNT);
        assert_eq!(defaults[0], "#ef444447");
        assert!(
            defaults.iter().eq(bundled.iter()),
            "the bundled defaults must already be canonical"
        );
        assert!(defaults.iter().all(|value| {
            value.len() == 9
                && value.starts_with('#')
                && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
                && value == &value.to_ascii_lowercase()
        }));

        let legacy: ProxySettings = serde_json::from_str("{}").expect("load legacy settings");
        assert_eq!(legacy.filter_color_presets, defaults);

        let json = serde_json::to_string(&legacy).expect("serialize settings");
        let back: ProxySettings = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(back.filter_color_presets, defaults);
    }

    #[test]
    fn filter_color_presets_canonicalize_every_alpha_byte_to_the_picker_domain() {
        for alpha in u8::MIN..=u8::MAX {
            // Integer forms of the frontend's Math.round(byte * 100 / 255),
            // then Math.round(percent * 255 / 100).
            let expected_percent = ((u16::from(alpha) * 100 + 127) / 255) as u8;
            let expected_byte = ((u16::from(expected_percent) * 255 + 50) / 100) as u8;
            assert_eq!(alpha_byte_to_percent(alpha), expected_percent);
            assert_eq!(alpha_percent_to_byte(expected_percent), expected_byte);

            let input = format!("#112233{alpha:02x}");
            let expected = format!("#112233{expected_byte:02x}");
            let canonical = normalize_filter_color_preset(&input, "#00000047")
                .expect("normalize valid eight-digit tint");
            assert_eq!(canonical, expected, "input {input}");
            assert_eq!(
                normalize_filter_color_preset(&canonical, "#00000047"),
                Some(canonical),
                "canonical output must be idempotent for input {input}"
            );
        }

        assert_eq!(
            normalize_filter_color_preset("#11223301", "#00000047").as_deref(),
            Some("#11223300")
        );
        let settings: ProxySettings =
            serde_json::from_str(r##"{"filterColorPresets":["#11223301"]}"##)
                .expect("normalize through the authoritative serde boundary");
        assert_eq!(settings.filter_color_presets[0], "#11223300");
        assert!(
            serde_json::to_string(&settings)
                .expect("serialize canonical settings")
                .contains("#11223300"),
            "the unrepresentable input byte must never be written back"
        );
    }

    #[test]
    fn filter_color_presets_retain_valid_slots_and_repair_malformed_short_input() {
        let settings: ProxySettings = serde_json::from_str(
            r##"{"filterColorPresets":[" #ABCDEF80 ",7,"#123456","#oops",null]}"##,
        )
        .expect("sanitize palette");
        let defaults = FilterColorPresets::default();

        assert_eq!(
            settings.filter_color_presets.len(),
            FILTER_COLOR_PRESET_COUNT
        );
        assert_eq!(settings.filter_color_presets[0], "#abcdef80");
        assert_eq!(settings.filter_color_presets[1], defaults[1]);
        assert_eq!(settings.filter_color_presets[2], "#12345647");
        assert_eq!(settings.filter_color_presets[3], defaults[3]);
        assert_eq!(settings.filter_color_presets[4], defaults[4]);
        assert_eq!(settings.filter_color_presets[9], defaults[9]);
    }

    #[test]
    fn filter_color_presets_truncate_long_input_and_repair_non_array_input() {
        let values: Vec<String> = (0..12).map(|index| format!("#{index:08x}")).collect();
        let text = serde_json::json!({ "filterColorPresets": values }).to_string();
        let settings: ProxySettings = serde_json::from_str(&text).expect("truncate palette");
        assert_eq!(
            settings.filter_color_presets.len(),
            FILTER_COLOR_PRESET_COUNT
        );
        assert_eq!(settings.filter_color_presets[0], "#00000000");
        assert_eq!(settings.filter_color_presets[9], "#0000000a");

        let malformed: ProxySettings = serde_json::from_str(r#"{"filterColorPresets":"nope"}"#)
            .expect("repair non-array palette");
        assert_eq!(
            malformed.filter_color_presets,
            FilterColorPresets::default()
        );
    }

    #[test]
    fn theme_defaults_system_and_round_trips_every_choice() {
        let legacy: ProxySettings = serde_json::from_str("{}").expect("load legacy settings");
        assert_eq!(legacy.theme, ColorTheme::System);

        for (theme, value) in [
            (ColorTheme::System, "system"),
            (ColorTheme::Dark, "dark"),
            (ColorTheme::Light, "light"),
        ] {
            let settings = ProxySettings {
                theme,
                ..Default::default()
            };
            let json = serde_json::to_string(&settings).expect("serialize settings");
            assert!(json.contains(&format!("\"theme\":\"{value}\"")));
            let back: ProxySettings = serde_json::from_str(&json).expect("round-trip");
            assert_eq!(back.theme, theme);
        }
    }

    #[test]
    fn repeated_wildcard_prefix_does_not_over_strip() {
        // Only one leading "*." is removed, so a malformed double wildcard does
        // NOT collapse to a bare suffix that would over-match every subdomain.
        let s = settings(&["*.*.example.com"]);
        assert!(!s.is_excluded("example.com"));
        assert!(!s.is_excluded("api.example.com"));
    }
}
