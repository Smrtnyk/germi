use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use proxy_core::ProxyController;
use tauri::async_runtime::JoinHandle;

/// Tauri-managed application state. The proxy engine lives entirely in
/// `proxy-core`; this just holds a shared handle to it plus where the CA lives.
pub struct AppState {
    pub controller: Arc<ProxyController>,
    pub ca_dir: PathBuf,
    /// Handle to the live flow-forwarder task (see `commands::subscribe_flows`).
    /// Stored so a re-subscribe (React Strict Mode double-mount, hot reload, or a
    /// future remount) aborts the prior task instead of leaking it.
    pub flow_forwarder: Mutex<Option<JoinHandle<()>>>,
}
