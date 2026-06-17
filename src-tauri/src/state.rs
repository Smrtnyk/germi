use std::path::PathBuf;
use std::sync::Arc;

use proxy_core::ProxyController;

/// Tauri-managed application state. The proxy engine lives entirely in
/// `proxy-core`; this just holds a shared handle to it plus where the CA lives.
pub struct AppState {
    pub controller: Arc<ProxyController>,
    pub ca_dir: PathBuf,
}
