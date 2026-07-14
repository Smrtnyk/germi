//! Persistence for small proxy-wide settings. Autoresponder scenarios and rules
//! live in the normalized `SQLite` store in `rule_store.rs`.

use std::io::Write;
use std::path::Path;

use proxy_core::{ProxySettings, Script};
use serde::{Deserialize, Serialize};

use crate::state::SystemProxyOwnership;
use crate::system_proxy::{SystemProxyConfig, WindowsProxyConfig};

const SETTINGS_FILE: &str = "settings.json";
const SCRIPTS_FILE: &str = "scripts.json";
const SYSTEM_PROXY_OWNERSHIP_FILE: &str = "system-proxy-ownership.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSystemProxy {
    enable: bool,
    host: String,
    port: u16,
    bypass: String,
    /// Added after the first ownership-journal release. `default` keeps
    /// journals written by that release readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    windows_raw: Option<WindowsProxyConfig>,
}

impl From<&SystemProxyConfig> for StoredSystemProxy {
    fn from(proxy: &SystemProxyConfig) -> Self {
        Self {
            enable: proxy.enable,
            host: proxy.host.clone(),
            port: proxy.port,
            bypass: proxy.bypass.clone(),
            windows_raw: proxy.windows_raw.clone(),
        }
    }
}

impl From<StoredSystemProxy> for SystemProxyConfig {
    fn from(proxy: StoredSystemProxy) -> Self {
        Self {
            enable: proxy.enable,
            host: proxy.host,
            port: proxy.port,
            bypass: proxy.bypass,
            windows_raw: proxy.windows_raw,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSystemProxyOwnership {
    prior: Option<StoredSystemProxy>,
    #[serde(default)]
    active_port: Option<u16>,
    #[serde(default)]
    pending_port: Option<u16>,
}

/// Write `contents` to `path` atomically: write a sibling temp file, flush +
/// fsync it, then rename it over the target (atomic on the same filesystem).
/// A crash / power loss / full disk mid-write thus leaves the previous file
/// intact instead of truncated — otherwise the next launch's `from_str(..).ok()`
/// would silently fall back to defaults, losing all the user's scenarios.
/// `NamedTempFile::persist` maps to a replacing move on Windows; plain
/// `std::fs::rename` cannot replace an existing file there, which made every
/// save after the first fail on that platform.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(contents)?;
    staged.as_file().sync_all()?;
    staged
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

/// Load saved proxy settings, or `None` if absent / unreadable / malformed.
pub fn load_settings(dir: &Path) -> Option<ProxySettings> {
    let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Save proxy settings atomically, surfacing filesystem failures to the caller.
pub fn save_settings(dir: &Path, settings: &ProxySettings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir).and_then(|()| {
        let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
        write_atomic(&dir.join(SETTINGS_FILE), text.as_bytes())
    })
}

/// Load saved user scripts, or `None` if absent / unreadable / malformed. Every
/// `Script` field is `#[serde(default)]`, so a file written by an older build
/// still loads.
pub fn load_scripts(dir: &Path) -> Option<Vec<Script>> {
    let text = std::fs::read_to_string(dir.join(SCRIPTS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Save user scripts (creates the app-data dir if missing). Uses
/// the same atomic write as settings so a crash mid-write can't truncate the file
/// and silently drop every script.
pub fn save_scripts(dir: &Path, scripts: &[Script]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir).and_then(|()| {
        let text = serde_json::to_string_pretty(scripts).map_err(std::io::Error::other)?;
        write_atomic(&dir.join(SCRIPTS_FILE), text.as_bytes())
    })
}

/// Persist the exact OS-proxy endpoint Germi owns plus the configuration it
/// must restore. This small journal survives a crash between takeover and the
/// normal exit hook; without it the next process cannot safely distinguish its
/// stale loopback proxy from another application's proxy.
pub fn save_system_proxy_ownership(
    dir: &Path,
    ownership: &SystemProxyOwnership,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir).and_then(|()| {
        let stored = StoredSystemProxyOwnership {
            prior: ownership.prior.as_ref().map(StoredSystemProxy::from),
            active_port: ownership.active_port,
            pending_port: ownership.pending_port,
        };
        let text = serde_json::to_string_pretty(&stored).map_err(std::io::Error::other)?;
        write_atomic(&dir.join(SYSTEM_PROXY_OWNERSHIP_FILE), text.as_bytes())
    })
}

pub fn load_system_proxy_ownership(dir: &Path) -> Option<SystemProxyOwnership> {
    let text = std::fs::read_to_string(dir.join(SYSTEM_PROXY_OWNERSHIP_FILE)).ok()?;
    let stored: StoredSystemProxyOwnership = serde_json::from_str(&text).ok()?;
    Some(SystemProxyOwnership {
        prior: stored.prior.map(SystemProxyConfig::from),
        active_port: stored.active_port,
        pending_port: stored.pending_port,
    })
}

pub fn clear_system_proxy_ownership(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(dir.join(SYSTEM_PROXY_OWNERSHIP_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_scripts_round_trip_after_successful_saves() {
        let dir = tempfile::tempdir().expect("temp dir");
        let settings = ProxySettings::default();
        let scripts = vec![Script {
            id: "s".into(),
            name: "script".into(),
            enabled: true,
            source: "fn on_request(req) {}".into(),
        }];
        save_settings(dir.path(), &ProxySettings::default()).expect("initial settings save");
        save_scripts(dir.path(), &[]).expect("initial scripts save");
        // Both destinations now exist: replacement must remain atomic and work
        // on Windows as well as Unix.
        save_settings(dir.path(), &settings).expect("replace settings");
        save_scripts(dir.path(), &scripts).expect("replace scripts");
        assert_eq!(
            serde_json::to_value(load_settings(dir.path()).expect("load settings")).expect("json"),
            serde_json::to_value(settings).expect("json"),
        );
        assert_eq!(load_scripts(dir.path()), Some(scripts));
    }

    #[test]
    fn save_failures_are_returned_instead_of_reported_as_success() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("not-a-directory");
        std::fs::write(&path, b"file").expect("seed file");
        assert!(save_settings(&path, &ProxySettings::default()).is_err());
        assert!(save_scripts(&path, &[]).is_err());
    }

    #[test]
    fn system_proxy_ownership_survives_a_process_restart() {
        let dir = tempfile::tempdir().expect("temp dir");
        let ownership = SystemProxyOwnership {
            prior: Some(SystemProxyConfig {
                enable: true,
                host: "proxy.example".into(),
                port: 3128,
                bypass: "localhost".into(),
                windows_raw: Some(WindowsProxyConfig {
                    enable: Some(1),
                    server: Some("http=proxy.example:80;https=secure.example:443".into()),
                    bypass: Some("localhost".into()),
                }),
            }),
            active_port: Some(8080),
            pending_port: Some(8081),
        };

        save_system_proxy_ownership(dir.path(), &ownership).expect("save ownership");
        assert_eq!(load_system_proxy_ownership(dir.path()), Some(ownership));
        clear_system_proxy_ownership(dir.path()).expect("clear ownership");
        assert_eq!(load_system_proxy_ownership(dir.path()), None);
    }
}
