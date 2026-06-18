//! Persistence for the autoresponder config (scenarios) under the app data dir,
//! alongside the CA. Plain JSON — the config is small and human-inspectable.

use std::io::Write;
use std::path::Path;

use proxy_core::{AutoResponder, ProxySettings};

const FILE: &str = "autoresponder.json";
const SETTINGS_FILE: &str = "settings.json";

/// Write `contents` to `path` atomically: write a sibling temp file, flush +
/// fsync it, then rename it over the target (atomic on the same filesystem).
/// A crash / power loss / full disk mid-write thus leaves the previous file
/// intact instead of truncated — otherwise the next launch's `from_str(..).ok()`
/// would silently fall back to defaults, losing all the user's scenarios.
fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Load the saved autoresponder, or `None` if absent / unreadable / malformed.
pub fn load_autoresponder(dir: &Path) -> Option<AutoResponder> {
    let text = std::fs::read_to_string(dir.join(FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Best-effort save. Logs (does not panic) on failure — the app-data dir is not
/// auto-created on Linux, so create it first.
pub fn save_autoresponder(dir: &Path, ar: &AutoResponder) {
    let result = std::fs::create_dir_all(dir).and_then(|()| {
        let text = serde_json::to_string_pretty(ar)
            .map_err(std::io::Error::other)?;
        write_atomic(&dir.join(FILE), text.as_bytes())
    });
    if let Err(e) = result {
        tracing::warn!("failed to persist autoresponder: {e}");
    }
}

/// Load saved proxy settings, or `None` if absent / unreadable / malformed.
pub fn load_settings(dir: &Path) -> Option<ProxySettings> {
    let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Best-effort save of proxy settings (creates the app-data dir if missing).
pub fn save_settings(dir: &Path, settings: &ProxySettings) {
    let result = std::fs::create_dir_all(dir).and_then(|()| {
        let text = serde_json::to_string_pretty(settings)
            .map_err(std::io::Error::other)?;
        write_atomic(&dir.join(SETTINGS_FILE), text.as_bytes())
    });
    if let Err(e) = result {
        tracing::warn!("failed to persist settings: {e}");
    }
}
