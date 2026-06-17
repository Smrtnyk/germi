//! Persistence for the autoresponder config (scenarios) under the app data dir,
//! alongside the CA. Plain JSON — the config is small and human-inspectable.

use std::path::Path;

use proxy_core::AutoResponder;

const FILE: &str = "autoresponder.json";

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
