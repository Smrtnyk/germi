//! Partial settings import/export (issue #112): settings are shared as plain
//! JSON keyed by the serde camelCase field names, grouped into user-facing
//! sections. Export writes only the selected sections' keys; import overlays
//! only the keys present in the file (and selected by the user) onto the
//! current settings, so a partial file never resets what it doesn't mention.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::settings::ProxySettings;

/// A user-selectable group of settings fields. `keys` are the camelCase JSON
/// field names of `ProxySettings` this section owns.
pub struct SettingsSection {
    pub id: &'static str,
    pub label: &'static str,
    pub keys: &'static [&'static str],
}

/// Every exportable section, in display order. Each `ProxySettings` field must
/// belong to exactly one section (checked by a test) so a new field can't
/// silently fall out of import/export.
pub const SETTINGS_SECTIONS: &[SettingsSection] = &[
    SettingsSection {
        id: "connections",
        label: "Connections",
        keys: &["port", "allowRemote"],
    },
    SettingsSection {
        id: "interception",
        label: "Host exclusions",
        keys: &["excludedHosts"],
    },
    SettingsSection {
        id: "capture",
        label: "Capture",
        keys: &["maxFlows", "captureFilter", "autoStartOnLaunch"],
    },
    SettingsSection {
        id: "throttling",
        label: "Throttling",
        keys: &["responseDelayMs"],
    },
    SettingsSection {
        id: "shortcuts",
        label: "System proxy hotkey",
        keys: &["systemProxyHotkey"],
    },
    SettingsSection {
        id: "appearance",
        label: "Highlight colors",
        keys: &["highlightColors"],
    },
    SettingsSection {
        id: "columns",
        label: "Header columns",
        keys: &["headerColumns"],
    },
];

/// One section as shown in the export checklist / import preview: the id the
/// frontend passes back, the label it renders, and a short human summary of
/// the values it covers.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionSummary {
    pub id: String,
    pub label: String,
    pub detail: String,
}

fn settings_object(settings: &ProxySettings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn count_noun(n: usize, noun: &str) -> String {
    if n == 1 { format!("1 {noun}") } else { format!("{n} {noun}s") }
}

/// Human summary of one section, built only from the fields in `present`
/// (for an import preview, fields the file doesn't carry are left out).
fn section_detail(id: &str, s: &ProxySettings, present: &Map<String, Value>) -> String {
    let has = |key: &str| present.contains_key(key);
    let mut parts: Vec<String> = Vec::new();
    match id {
        "connections" => {
            if has("port") {
                parts.push(format!("port {}", s.port));
            }
            if has("allowRemote") {
                parts.push(format!("remote devices {}", if s.allow_remote { "allowed" } else { "blocked" }));
            }
        }
        "interception" => parts.push(count_noun(s.excluded_hosts.len(), "excluded host")),
        "capture" => {
            if has("maxFlows") {
                parts.push(format!("keep {} flows", s.max_flows));
            }
            if has("captureFilter") {
                parts.push(if s.capture_filter.is_empty() {
                    "no host filter".to_string()
                } else {
                    format!("{} filter", count_noun(s.capture_filter.len(), "host"))
                });
            }
            if has("autoStartOnLaunch") {
                parts.push(format!("auto-start {}", if s.auto_start_on_launch { "on" } else { "off" }));
            }
        }
        "throttling" => parts.push(if s.response_delay_ms == 0 {
            "off".to_string()
        } else {
            format!("{} ms response delay", s.response_delay_ms)
        }),
        "shortcuts" => parts.push(if s.system_proxy_hotkey.is_empty() {
            "not set".to_string()
        } else {
            s.system_proxy_hotkey.clone()
        }),
        "appearance" => parts.push(count_noun(s.highlight_colors.len(), "color override")),
        "columns" => parts.push(count_noun(s.header_columns.len(), "pinned column")),
        _ => {}
    }
    parts.join(" · ")
}

/// Summaries of ALL sections for the current settings — drives the export
/// checklist.
pub fn section_summaries(settings: &ProxySettings) -> Vec<SectionSummary> {
    let object = settings_object(settings);
    SETTINGS_SECTIONS
        .iter()
        .map(|section| SectionSummary {
            id: section.id.to_string(),
            label: section.label.to_string(),
            detail: section_detail(section.id, settings, &object),
        })
        .collect()
}

/// Serialize only the selected sections' fields to pretty JSON for export.
pub fn export_sections(settings: &ProxySettings, section_ids: &[String]) -> String {
    let full = settings_object(settings);
    let mut out = Map::new();
    for section in selected(section_ids) {
        for key in section.keys {
            if let Some(value) = full.get(*key) {
                out.insert((*key).to_string(), value.clone());
            }
        }
    }
    serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string())
}

fn selected(section_ids: &[String]) -> impl Iterator<Item = &'static SettingsSection> + '_ {
    SETTINGS_SECTIONS
        .iter()
        .filter(|section| section_ids.iter().any(|id| id == section.id))
}

fn parse_import(text: &str) -> Result<(ProxySettings, Map<String, Value>), String> {
    let typed: ProxySettings =
        serde_json::from_str(text).map_err(|e| format!("Invalid settings file: {e}"))?;
    let Ok(Value::Object(object)) = serde_json::from_str(text) else {
        return Err("Invalid settings file: not a JSON object".to_string());
    };
    Ok((typed, object))
}

/// Preview an import: which sections the file carries, with details taken from
/// the file's values. Errors when the file isn't valid settings JSON or holds
/// no known settings at all.
pub fn import_preview(text: &str) -> Result<Vec<SectionSummary>, String> {
    let (typed, object) = parse_import(text)?;
    let found: Vec<SectionSummary> = SETTINGS_SECTIONS
        .iter()
        .filter(|section| section.keys.iter().any(|key| object.contains_key(*key)))
        .map(|section| SectionSummary {
            id: section.id.to_string(),
            label: section.label.to_string(),
            detail: section_detail(section.id, &typed, &object),
        })
        .collect();
    if found.is_empty() {
        return Err("No Germi settings found in this file".to_string());
    }
    Ok(found)
}

/// Apply an import: overlay the file's fields — but only those in the selected
/// sections — onto `current`. Fields the file doesn't mention (or sections the
/// user unchecked) keep their current values.
pub fn merge_import(
    current: &ProxySettings,
    text: &str,
    section_ids: &[String],
) -> Result<ProxySettings, String> {
    let (_, incoming) = parse_import(text)?;
    let mut merged = settings_object(current);
    for section in selected(section_ids) {
        for key in section.keys {
            if let Some(value) = incoming.get(*key) {
                merged.insert((*key).to_string(), value.clone());
            }
        }
    }
    serde_json::from_value(Value::Object(merged)).map_err(|e| format!("Invalid settings file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProxySettings {
        let mut s = ProxySettings {
            port: 9999,
            allow_remote: true,
            excluded_hosts: vec!["spotify.com".into(), "slack.com".into()],
            capture_filter: vec!["api.example.com".into()],
            response_delay_ms: 500,
            system_proxy_hotkey: "Ctrl+Shift+P".into(),
            header_columns: vec!["req:x-trace-id".into()],
            ..ProxySettings::default()
        };
        s.highlight_colors.insert("row-mocked".into(), "#ff000040".into());
        s
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn every_settings_field_belongs_to_exactly_one_section() {
        let object = settings_object(&ProxySettings::default());
        for key in object.keys() {
            let owners = SETTINGS_SECTIONS
                .iter()
                .filter(|s| s.keys.contains(&key.as_str()))
                .count();
            assert_eq!(owners, 1, "field `{key}` must belong to exactly one section");
        }
        let known: usize = SETTINGS_SECTIONS.iter().map(|s| s.keys.len()).sum();
        assert_eq!(known, object.len(), "registry lists a field ProxySettings doesn't have");
    }

    #[test]
    fn export_includes_only_selected_sections() {
        let text = export_sections(&sample(), &ids(&["interception", "throttling"]));
        let parsed: Value = serde_json::from_str(&text).unwrap();
        let object = parsed.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert_eq!(parsed["excludedHosts"], serde_json::json!(["spotify.com", "slack.com"]));
        assert_eq!(parsed["responseDelayMs"], serde_json::json!(500));
    }

    #[test]
    fn export_all_sections_round_trips_every_field() {
        let all: Vec<String> = SETTINGS_SECTIONS.iter().map(|s| s.id.to_string()).collect();
        let text = export_sections(&sample(), &all);
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed, serde_json::to_value(sample()).unwrap());
    }

    #[test]
    fn summaries_cover_all_sections_with_details() {
        let summaries = section_summaries(&sample());
        assert_eq!(summaries.len(), SETTINGS_SECTIONS.len());
        let by_id = |id: &str| summaries.iter().find(|s| s.id == id).unwrap().detail.clone();
        assert_eq!(by_id("connections"), "port 9999 · remote devices allowed");
        assert_eq!(by_id("interception"), "2 excluded hosts");
        assert_eq!(by_id("capture"), "keep 5000 flows · 1 host filter · auto-start on");
        assert_eq!(by_id("throttling"), "500 ms response delay");
        assert_eq!(by_id("shortcuts"), "Ctrl+Shift+P");
        assert_eq!(by_id("appearance"), "1 color override");
        assert_eq!(by_id("columns"), "1 pinned column");
    }

    #[test]
    fn preview_lists_only_sections_present_in_the_file() {
        let found = import_preview(r#"{"excludedHosts":["slack.com"],"port":8888}"#).unwrap();
        let found_ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(found_ids, ["connections", "interception"]);
        assert_eq!(found[0].detail, "port 8888");
        assert_eq!(found[1].detail, "1 excluded host");
    }

    #[test]
    fn preview_detail_skips_fields_the_file_does_not_carry() {
        let found = import_preview(r#"{"maxFlows":100}"#).unwrap();
        assert_eq!(found[0].detail, "keep 100 flows");
    }

    #[test]
    fn preview_rejects_wrong_types_junk_and_empty_objects() {
        assert!(import_preview(r#"{"port":"not-a-number"}"#).is_err());
        assert!(import_preview("not json").is_err());
        assert!(import_preview(r"[1,2]").is_err());
        assert!(import_preview(r#"{"unrelated":true}"#).is_err());
    }

    #[test]
    fn merge_overlays_only_selected_sections_present_in_the_file() {
        let current = sample();
        let file = r#"{"excludedHosts":["youtube.com"],"port":1234,"responseDelayMs":0}"#;
        let merged = merge_import(&current, file, &ids(&["interception", "throttling"])).unwrap();
        assert_eq!(merged.excluded_hosts, vec!["youtube.com".to_string()]);
        assert_eq!(merged.response_delay_ms, 0);
        assert_eq!(merged.port, 9999, "unselected section must keep the current value");
        assert!(merged.allow_remote);
        assert_eq!(merged.capture_filter, vec!["api.example.com".to_string()]);
    }

    #[test]
    fn merge_keeps_current_values_for_fields_missing_from_the_file() {
        let merged = merge_import(&sample(), r#"{"maxFlows":100}"#, &ids(&["capture"])).unwrap();
        assert_eq!(merged.max_flows, 100);
        assert_eq!(merged.capture_filter, vec!["api.example.com".to_string()]);
        assert!(merged.auto_start_on_launch);
    }

    #[test]
    fn merge_rejects_invalid_files() {
        assert!(merge_import(&sample(), r#"{"port":99999999}"#, &ids(&["connections"])).is_err());
        assert!(merge_import(&sample(), "nope", &ids(&["connections"])).is_err());
    }
}
