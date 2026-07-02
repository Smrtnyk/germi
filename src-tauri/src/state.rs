use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use proxy_core::ProxyController;
use tauri::async_runtime::JoinHandle;

use crate::rule_store::RuleStore;

/// Tauri-managed application state. The proxy engine lives entirely in
/// `proxy-core`; this just holds a shared handle to it plus where the CA lives.
pub struct AppState {
    pub controller: Arc<ProxyController>,
    pub rule_store: Arc<RuleStore>,
    pub ca_dir: PathBuf,
    /// Handle to the live flow-forwarder task (see `commands::subscribe_flows`).
    /// Stored so a re-subscribe (React Strict Mode double-mount, hot reload, or a
    /// future remount) aborts the prior task instead of leaking it.
    pub flow_forwarder: Mutex<Option<JoinHandle<()>>>,
    pub prior_system_proxy: Mutex<Option<sysproxy::Sysproxy>>,
    /// Hand-off mailbox for the compare window (issue #86): the main window
    /// stores the seed flow ids here before opening/focusing the `compare`
    /// window, which reads them back on mount and on every re-seed. Sturdier
    /// than URL params (no length limit for a select-all seed) and it survives
    /// a webview reload of the compare window.
    pub compare_seed: Mutex<Option<crate::commands::CompareSeed>>,
    /// Live XDG `GlobalShortcuts` portal binding (Wayland global hotkey).
    pub portal_hotkey: crate::portal_hotkey::PortalHotkey,
    /// Launched with `--viewer`: the proxy engine is disabled (this instance
    /// only inspects saved captures), so a second Germi can run alongside the
    /// capturing one without fighting over the proxy port / system proxy.
    pub viewer: bool,
}
