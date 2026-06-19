//! IPC commands exposed to the webview.
//!
//! Async commands clone the `Arc<ProxyController>` out of `State` *before*
//! awaiting so we never hold the state borrow across an `.await`. Live traffic
//! is pushed over a [`Channel`] in batches (see `subscribe_flows`) rather than
//! one IPC message per request — the bridge, not the proxy, is the bottleneck.

use std::net::SocketAddr;
use std::time::Duration;

use proxy_core::{
    AutoResponder, FlowDetail, FlowEvent, FlowSummary, MockResult, ProxySettings, RuleSet,
    SearchSide, TestInput, TestResult,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaInfo {
    pub cert_pem: String,
    pub cert_path: String,
    pub dir: String,
}

#[tauri::command]
pub async fn proxy_status(state: State<'_, AppState>) -> Result<bool, String> {
    let controller = state.controller.clone();
    Ok(controller.is_running().await)
}

#[tauri::command]
pub async fn start_proxy(
    state: State<'_, AppState>,
    port: u16,
    allow_remote: bool,
) -> Result<u16, String> {
    let controller = state.controller.clone();
    // Bind 0.0.0.0 (LAN-reachable) only when explicitly allowed; loopback otherwise.
    let ip = if allow_remote { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((ip, port));
    // Returns the actually-bound address (resolving port 0); a bind failure
    // surfaces here as Err instead of the proxy silently dying after "running".
    let bound = controller.start(addr).await.map_err(|e| e.to_string())?;
    Ok(bound.port())
}

#[tauri::command]
pub async fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    let controller = state.controller.clone();
    controller.stop().await;
    Ok(())
}

/// Open a long-lived channel the backend pushes batches of [`FlowEvent`] into.
/// The forwarder is tracked in `AppState` so a re-subscribe aborts the prior
/// task (it can't self-terminate: nulling `onmessage` in the webview leaves the
/// Tauri channel alive, so its `send` keeps succeeding).
#[tauri::command]
pub async fn subscribe_flows(
    state: State<'_, AppState>,
    channel: Channel<Vec<FlowEvent>>,
) -> Result<(), String> {
    let mut rx = state.controller.subscribe();
    let handle = tauri::async_runtime::spawn(async move {
        let mut buf: Vec<FlowEvent> = Vec::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(60));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                received = rx.recv() => match received {
                    Ok(event) => {
                        buf.push(event);
                        if buf.len() >= 200 && channel.send(std::mem::take(&mut buf)).is_err() {
                            break;
                        }
                    }
                    // Subscriber fell behind and events were dropped; tell the UI
                    // to re-list and resynchronize (flushed with the next batch).
                    Err(RecvError::Lagged(_)) => buf.push(FlowEvent::Resync),
                    Err(RecvError::Closed) => break,
                },
                _ = ticker.tick() => {
                    if !buf.is_empty() && channel.send(std::mem::take(&mut buf)).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // Replace (and abort) any prior forwarder so a re-subscribe doesn't leak it.
    // No `.await` is held across this lock, so a std Mutex is fine.
    if let Ok(mut slot) = state.flow_forwarder.lock() {
        if let Some(prev) = slot.replace(handle) {
            prev.abort();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_flows(state: State<'_, AppState>) -> Vec<FlowSummary> {
    state.controller.list_flows()
}

#[tauri::command]
pub fn get_flow(
    state: State<'_, AppState>,
    id: String,
    decoded: bool,
    full: bool,
) -> Option<FlowDetail> {
    state.controller.get_flow(&id, decoded, full)
}

#[tauri::command]
pub fn clear_flows(state: State<'_, AppState>) {
    state.controller.clear_flows();
}

/// Remove specific captured flows by id (prune noise before saving a session).
#[tauri::command]
pub fn remove_flows(state: State<'_, AppState>, ids: Vec<String>) {
    state.controller.remove_flows(&ids);
}

/// Set or clear a flow's user comment (re-emits the row to the live stream).
#[tauri::command]
pub fn set_flow_comment(state: State<'_, AppState>, id: String, comment: Option<String>) {
    state.controller.set_flow_comment(&id, comment);
}

#[tauri::command]
pub fn get_autoresponder(state: State<'_, AppState>) -> AutoResponder {
    state.controller.get_autoresponder()
}

#[tauri::command]
pub fn set_autoresponder(state: State<'_, AppState>, autoresponder: AutoResponder) {
    state.controller.set_autoresponder(autoresponder.clone());
    crate::persist::save_autoresponder(&state.ca_dir, &autoresponder);
}

#[tauri::command]
pub fn reset_rule_state(state: State<'_, AppState>, scenario_id: Option<String>) {
    state.controller.reset_rule_state(scenario_id.as_deref());
}

#[tauri::command]
pub fn rule_hits(state: State<'_, AppState>) -> std::collections::HashMap<String, u32> {
    state.controller.rule_hits()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> ProxySettings {
    state.controller.get_settings()
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: ProxySettings) {
    state.controller.set_settings(settings.clone());
    crate::persist::save_settings(&state.ca_dir, &settings);
}

/// Simulate a rule set against a sample request without touching the network.
#[tauri::command]
pub fn test_rules(rules: RuleSet, input: TestInput) -> TestResult {
    proxy_core::test_rules(&rules, &input)
}

/// Seed Respond rules from the given captured flows into a scenario, persist,
/// and return the updated autoresponder + the new rule ids.
#[tauri::command]
pub fn mock_flows(
    state: State<'_, AppState>,
    ids: Vec<String>,
    scenario_id: Option<String>,
) -> MockResult {
    let result = state.controller.mock_flows(&ids, scenario_id.as_deref());
    crate::persist::save_autoresponder(&state.ca_dir, &result.autoresponder);
    result
}

#[tauri::command]
pub fn ca_info(state: State<'_, AppState>) -> CaInfo {
    CaInfo {
        cert_pem: state.controller.ca_cert_pem(),
        cert_path: state
            .ca_dir
            .join("germi-ca.pem")
            .to_string_lossy()
            .into_owned(),
        dir: state.ca_dir.to_string_lossy().into_owned(),
    }
}

/// Export the root CA certificate to a user-chosen file (PEM, or DER by extension).
#[tauri::command]
pub async fn export_ca(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Certificate", &["pem", "crt", "cer", "der"])
        .set_file_name("germi-ca.pem")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let is_der = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("der"));
    if is_der {
        std::fs::write(&path, state.controller.ca_cert_der()).map_err(|e| e.to_string())?;
    } else {
        std::fs::write(&path, state.controller.ca_cert_pem()).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Generate a fresh root CA (proxy must be stopped). The user must re-trust it.
#[tauri::command]
pub async fn regenerate_ca(state: State<'_, AppState>) -> Result<(), String> {
    state
        .controller
        .regenerate_ca(&state.ca_dir)
        .await
        .map_err(|e| e.to_string())
}

/// Route the OS system proxy through Germi (Windows `WinINET` / GNOME / KDE).
#[tauri::command]
pub fn set_system_proxy(port: u16) -> Result<(), String> {
    let sp = sysproxy::Sysproxy {
        enable: true,
        host: "127.0.0.1".to_string(),
        port,
        bypass: "localhost,127.0.0.1,::1".to_string(),
    };
    sp.set_system_proxy().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_system_proxy() -> Result<(), String> {
    let mut sp = sysproxy::Sysproxy::get_system_proxy().map_err(|e| e.to_string())?;
    sp.enable = false;
    sp.set_system_proxy().map_err(|e| e.to_string())
}

/// Open a native file picker and import a HAR or Fiddler SAZ archive into the
/// traffic list. Returns the number of flows imported (0 if the user cancels).
#[tauri::command]
pub async fn import_archive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("captures", &["har", "saz"])
        .blocking_pick_file()
    else {
        return Ok(0); // cancelled
    };

    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "har" => state.controller.import_har(&bytes).map_err(|e| e.to_string()),
        "saz" => state.controller.import_saz(&bytes).map_err(|e| e.to_string()),
        other => Err(format!("Unsupported file type: .{other}")),
    }
}

/// Open a native file picker (any file) and return the chosen path, for the
/// Map Local action's "Browse…" button.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Whether a path exists and is a regular file (Map Local validation).
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// Body-content search: return the ids of flows whose (decompressed) body matches.
#[tauri::command]
pub fn search_bodies(
    state: State<'_, AppState>,
    pattern: String,
    side: SearchSide,
    regex: bool,
    candidates: Option<Vec<String>>,
) -> Vec<String> {
    state
        .controller
        .search_bodies(&pattern, side, regex, candidates.as_deref())
}

/// Save the current traffic to a `.germi` session file. Returns false if cancelled.
#[tauri::command]
pub async fn save_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi session", &["germi"])
        .set_file_name("session.germi")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, state.controller.export_session()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Open a `.germi` session, REPLACING the current traffic. Returns the count.
#[tauri::command]
pub async fn open_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi session", &["germi"])
        .blocking_pick_file()
    else {
        return Ok(0);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    state
        .controller
        .import_session(&bytes)
        .map_err(|e| e.to_string())
}

/// Export autoresponder scenarios to a `.germi-rules` file. With `scenario_id`
/// only that scenario is written; otherwise the whole config. Returns false if
/// the user cancels.
#[tauri::command]
pub async fn export_rules(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scenario_id: Option<String>,
) -> Result<bool, String> {
    let controller = state.controller.clone();
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi rules", &["germi-rules"])
        .set_file_name("autoresponder.germi-rules")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, controller.export_rules(scenario_id.as_deref()))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Import autoresponder scenarios from a `.germi-rules` file. `replace == false`
/// merges (appends); `replace == true` wipes the existing scenarios first.
/// Persists the merged config and returns the number of scenarios imported (0 if
/// the user cancels).
#[tauri::command]
pub async fn import_rules(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    replace: bool,
) -> Result<usize, String> {
    let controller = state.controller.clone();
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi rules", &["germi-rules"])
        .blocking_pick_file()
    else {
        return Ok(0);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let count = controller.import_rules(&bytes, replace).map_err(|e| e.to_string())?;
    crate::persist::save_autoresponder(&state.ca_dir, &controller.get_autoresponder());
    Ok(count)
}

/// Export the current proxy settings to a user-chosen JSON file.
#[tauri::command]
pub async fn export_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi settings", &["json"])
        .set_file_name("germi-settings.json")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let settings = state.controller.get_settings();
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Import proxy settings from a JSON file, applying + persisting them. Returns
/// the new settings (or the unchanged current settings if cancelled).
#[tauri::command]
pub async fn import_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProxySettings, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Germi settings", &["json"])
        .blocking_pick_file()
    else {
        return Ok(state.controller.get_settings());
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let settings: ProxySettings =
        serde_json::from_str(&text).map_err(|e| format!("Invalid settings file: {e}"))?;
    state.controller.set_settings(settings.clone());
    crate::persist::save_settings(&state.ca_dir, &settings);
    Ok(settings)
}
