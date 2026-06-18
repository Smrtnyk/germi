//! Persistence for the autoresponder config (scenarios) under the app data dir,
//! alongside the CA. Plain JSON — the config is small and human-inspectable.

use std::path::Path;

use proxy_core::{AutoResponder, ProxySettings};

const FILE: &str = "autoresponder.json";
const SETTINGS_FILE: &str = "settings.json";

/// Load the saved autoresponder, or `None` if absent / unreadable / malformed.
pub fn load_autoresponder(dir: &Path) -> Option<AutoResponder> {
    let text = std::fs::read_to_string(dir.join(FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Best-effort save. Logs (does not panic) on failure — the app-data dir is not
/// auto-created on Linux, so create it first.
pub fn save_autoresponder(dir: &Path, ar: &AutoResponder) {
    let result = std::fs::create_dir_all(dir).and_then(|_| {
        let text = serde_json::to_string_pretty(ar)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(dir.join(FILE), text)
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
    let result = std::fs::create_dir_all(dir).and_then(|_| {
        let text = serde_json::to_string_pretty(settings)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(dir.join(SETTINGS_FILE), text)
    });
    if let Err(e) = result {
        tracing::warn!("failed to persist settings: {e}");
    }
}
