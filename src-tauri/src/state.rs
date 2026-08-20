use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use proxy_core::ProxyController;
use tauri::async_runtime::JoinHandle;

use crate::rule_store::RuleStore;
use crate::system_proxy::SystemProxyConfig;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SystemProxyOwnership {
    /// OS proxy configuration that was active before Germi first took over.
    pub(crate) prior: Option<SystemProxyConfig>,
    /// Exact listener port Germi most recently configured successfully. A
    /// loopback proxy on any other port belongs to somebody else.
    pub(crate) active_port: Option<u16>,
    /// Port staged in the ownership journal before an OS re-point. Keeping both
    /// the last confirmed and pending endpoints makes either side of a process
    /// crash recognizable and safely restorable on the next launch.
    pub(crate) pending_port: Option<u16>,
}

/// Embedded-rule mailbox versioned by the monotonically increasing capture
/// import id. If overlapping commands finish their shell-level work out of
/// order, an older completion can never overwrite the newest offer.
#[derive(Default)]
pub struct PendingHarRules {
    pub import_id: u64,
    pub bundle: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct CaptureImportBatchExpectation {
    pub batch_index: u64,
    pub acknowledged: bool,
}

pub struct CaptureImportBatchAck {
    pub expected: Arc<Mutex<CaptureImportBatchExpectation>>,
    pub sender: tokio::sync::mpsc::UnboundedSender<u64>,
}

pub enum CaptureImportBatchDelivery {
    Reserved,
    Waiting(CaptureImportBatchAck),
    Cancelled,
}

pub type CaptureImportBatchAcks = Arc<Mutex<HashMap<u64, CaptureImportBatchDelivery>>>;

pub struct PreparedLaunchCapture {
    pub operation_id: u64,
    pub path: PathBuf,
}

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
    pub system_proxy_ownership: Mutex<SystemProxyOwnership>,
    /// Hand-off mailbox for the compare window (issue #86): the main window
    /// stores the seed flow ids here before opening/focusing the `compare`
    /// window, which reads them back on mount and on every re-seed. Sturdier
    /// than URL params (no length limit for a select-all seed) and it survives
    /// a webview reload of the compare window.
    pub compare_seed: Mutex<Option<crate::commands::CompareSeed>>,
    /// Settings file picked by `peek_settings_import`, held until the user
    /// confirms the previewed sections and `apply_settings_import` merges it
    /// (issue #112).
    pub pending_settings_import: Mutex<Option<String>>,
    /// Serializes full settings snapshots from ordinary saves and imports. Both
    /// commands persist outside the webview thread; without one queue, an older
    /// blocking write can finish after a newer import and clobber it on disk.
    pub settings_ops: tokio::sync::Mutex<()>,
    /// Detached and docked editors can overlap briefly while handing off the
    /// single-writer role. Keep their blocking full-file saves in invoke order.
    pub scripts_ops: tokio::sync::Mutex<()>,
    /// Mock-rules bundle found inside the last opened HAR (its `_germiRules`
    /// field), held until the user confirms the offer and `apply_har_rules`
    /// imports it (issue #113).
    pub pending_har_rules: Arc<Mutex<PendingHarRules>>,
    /// Compare imports acknowledge each bounded summary batch before their
    /// authoritative invoke settles, keeping Finalizing visible until the
    /// frontend has consumed every post-commit payload.
    pub capture_import_batch_acks: CaptureImportBatchAcks,
    /// Capture path supplied by the OS file association at process launch.
    /// The frontend consumes it once after its flow subscription is ready.
    pub launch_capture: crate::launch::PendingCapture,
    /// Launch-path preflight takes the one-shot mailbox before reserving global
    /// import ownership. Keeping the path behind its operation id lets the
    /// ordinary progress hook claim it without empty reloads disturbing a real
    /// import in another window.
    pub prepared_launch_capture: Arc<Mutex<Option<PreparedLaunchCapture>>>,
    /// Standalone rules file picked by `peek_rules_import`, held until the UI
    /// either applies it directly or asks how an included General layer should
    /// be routed (issue #122).
    pub pending_rules_import: Mutex<Option<Vec<u8>>>,
    /// Live XDG `GlobalShortcuts` portal binding (Wayland global hotkey).
    pub portal_hotkey: crate::portal_hotkey::PortalHotkey,
    /// Launched with `--viewer`: the proxy engine is disabled (this instance
    /// only inspects saved captures), so a second Germi can run alongside the
    /// capturing one without fighting over the proxy port / system proxy.
    pub viewer: bool,
}
