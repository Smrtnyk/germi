//! IPC commands exposed to the webview.
//!
//! Async commands clone the `Arc<ProxyController>` out of `State` *before*
//! awaiting so we never hold the state borrow across an `.await`. Live traffic
//! is pushed over a [`Channel`] in batches (see `subscribe_flows`) rather than
//! one IPC message per request — the bridge, not the proxy, is the bottleneck.

use std::net::SocketAddr;
use std::time::Duration;

use base64::Engine;
use proxy_core::{
    AutoResponderSummary, BodyComparison, FlowDetail, FlowEvent, FlowSummary, HistoryStep,
    HistoryTag, MockResult, ProxySettings, Rule, RuleSearchScope, RuleSummary, Scenario,
    ScenarioSummary, Script, ScriptDiagnostic, SearchSide, TestInput, TestResult,
    GENERAL_SCENARIO_ID,
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

/// Progress for an in-flight doc public-availability check. Per-flow verdicts
/// arrive on the live flow stream (each row updates as it resolves); this channel
/// only carries the running count for the button's progress label.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityProgress {
    pub completed: usize,
    pub total: usize,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BulkMockEvent {
    Progress {
        completed: usize,
        total: usize,
        phase: &'static str,
    },
    Created {
        scenario_id: String,
        rules: Vec<RuleSummary>,
    },
}

#[tauri::command]
pub async fn proxy_status(state: State<'_, AppState>) -> Result<bool, String> {
    let controller = state.controller.clone();
    Ok(controller.is_running().await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundAddr {
    pub port: u16,
    pub allow_remote: bool,
}

/// The live listen address (port + LAN scope), or `None` if stopped. Lets the
/// webview re-read reality after a reload instead of trusting the persisted port.
#[tauri::command]
pub async fn bound_addr(state: State<'_, AppState>) -> Result<Option<BoundAddr>, String> {
    let controller = state.controller.clone();
    Ok(controller.bound_addr().await.map(|addr| BoundAddr {
        port: addr.port(),
        allow_remote: addr.ip().is_unspecified(),
    }))
}

/// Bind `0.0.0.0` (LAN-reachable) only when explicitly allowed; loopback otherwise.
fn listen_addr(port: u16, allow_remote: bool) -> SocketAddr {
    let ip = if allow_remote { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    SocketAddr::from((ip, port))
}

/// Whether this instance was launched in viewer mode (`--viewer`): the proxy is
/// disabled and only saved captures can be inspected. The frontend hides the
/// proxy controls and shows a viewer badge when true.
#[tauri::command]
pub fn is_viewer_mode(state: State<'_, AppState>) -> bool {
    state.viewer
}

/// Launch a second Germi in viewer mode (`--viewer`) — a proxy-less inspector
/// that can run alongside the capturing instance. Works from a normal *or* a
/// viewer instance (spawning the same executable either way).
#[tauri::command]
pub fn launch_viewer() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = std::process::Command::new(exe)
        .arg("--viewer")
        .spawn()
        .map_err(|e| format!("failed to launch viewer: {e}"))?;
    // Reap the child once it exits so a closed viewer window doesn't linger as a
    // zombie in this long-lived process (Unix has no auto-reaping `Child` drop).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
pub async fn start_proxy(
    state: State<'_, AppState>,
    port: u16,
    allow_remote: bool,
) -> Result<u16, String> {
    // Defense in depth: the UI hides the Start control in viewer mode, but never
    // let a viewer instance bind the proxy port and fight the capturing one.
    if state.viewer {
        return Err("Proxy is disabled in viewer mode".to_string());
    }
    let controller = state.controller.clone();
    // Returns the actually-bound address (resolving port 0); a bind failure
    // surfaces here as Err instead of the proxy silently dying after "running".
    let bound = controller
        .start(listen_addr(port, allow_remote))
        .await
        .map_err(|e| e.to_string())?;
    Ok(bound.port())
}

/// Rebind the running proxy to a new port (settings changed while running).
#[tauri::command]
pub async fn restart_proxy(
    state: State<'_, AppState>,
    port: u16,
    allow_remote: bool,
) -> Result<u16, String> {
    // Defense in depth (as in `start_proxy`): `ProxyController::restart` starts the
    // proxy when nothing is running, so without this a viewer could bind a live
    // proxy and fight the capturing instance for the port.
    if state.viewer {
        return Err("Proxy is disabled in viewer mode".to_string());
    }
    let controller = state.controller.clone();
    let bound = controller
        .restart(listen_addr(port, allow_remote))
        .await
        .map_err(|e| e.to_string())?;
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
    // Take the slot lock BEFORE spawning so two concurrent subscribes (React Strict
    // Mode double-mount / hot reload) can't interleave: whoever holds the lock
    // aborts the prior forwarder and installs its own atomically. Spawning under
    // the lock is fine — it's synchronous, no `.await` is held. Without this, a
    // spawn-then-lock race could abort the newest forwarder (the live channel) and
    // leave a dead one feeding a nulled-onmessage channel.
    if let Ok(mut slot) = state.flow_forwarder.lock() {
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
pub async fn get_flow(
    state: State<'_, AppState>,
    id: String,
    decoded: bool,
    full: bool,
) -> Result<Option<FlowDetail>, String> {
    // Decoding + base64-encoding an up-to-64 MB body is heavy; run it on the
    // blocking pool so a large flow can't freeze the webview's IPC thread.
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || controller.get_flow(&id, decoded, full))
        .await
        .map_err(|e| format!("get_flow task failed: {e}"))
}

#[tauri::command]
pub fn clear_flows(state: State<'_, AppState>) {
    state.controller.clear_flows_tracked();
}

/// Remove specific captured flows by id (prune noise before saving a session).
/// Recorded on the undo timeline so an accidental prune can be reverted.
#[tauri::command]
pub fn remove_flows(state: State<'_, AppState>, ids: Vec<String>) {
    state.controller.remove_flows_tracked(&ids);
}

/// Remove every live-captured (non-imported) flow, keeping flows loaded from a
/// file (HAR / SAZ / `.germi`) — clears the replay noise while keeping the
/// imported reference (issue #49). Recorded on the undo timeline.
#[tauri::command]
pub fn remove_captured_flows(state: State<'_, AppState>) {
    state.controller.remove_captured_flows();
}

/// Set or clear a flow's user comment (re-emits the row to the live stream).
#[tauri::command]
pub fn set_flow_comment(state: State<'_, AppState>, id: String, comment: Option<String>) {
    state.controller.set_flow_comment(&id, comment);
}

#[tauri::command]
pub fn get_autoresponder_summary(state: State<'_, AppState>) -> AutoResponderSummary {
    state.controller.autoresponder_summary()
}

#[tauri::command]
pub async fn get_rule(
    state: State<'_, AppState>,
    rule_id: String,
) -> Result<Option<Rule>, String> {
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || controller.get_rule(&rule_id))
        .await
        .map_err(|e| format!("rule lookup task failed: {e}"))
}

#[tauri::command]
pub fn set_active_scenario(
    state: State<'_, AppState>,
    scenario_id: Option<String>,
    history_tag: HistoryTag,
) -> Result<(), String> {
    // Reject the built-in General scenario before touching the store — General
    // stacks via `set_general_active`, it is never the active scenario.
    if scenario_id.as_deref() == Some(GENERAL_SCENARIO_ID) {
        return Err("the built-in General scenario cannot be the active scenario".to_string());
    }
    state
        .rule_store
        .set_active_scenario(scenario_id.as_deref())?;
    state.controller.with_history(history_tag, |c| {
        c.set_active_scenario(scenario_id.as_deref())
            .map_err(|e| e.to_string())
    })
}

/// Toggle the built-in General layer on/off. Persisted, then applied to the live
/// engine (undo-tracked) so it takes effect for new traffic immediately.
#[tauri::command]
pub fn set_general_active(
    state: State<'_, AppState>,
    active: bool,
    history_tag: HistoryTag,
) -> Result<(), String> {
    state.rule_store.set_general_active(active)?;
    state.controller.with_history(history_tag, |c| {
        c.set_general_active(active).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn create_scenario(
    state: State<'_, AppState>,
    name: Option<String>,
    history_tag: HistoryTag,
) -> Result<ScenarioSummary, String> {
    state.controller.with_history(history_tag, |c| {
        let summary = c.create_scenario(name.as_deref()).map_err(|e| e.to_string())?;
        let scenario = Scenario {
            id: summary.id.clone(),
            name: summary.name.clone(),
            rules: Vec::new(),
        };
        if let Err(error) = state.rule_store.insert_scenario(&scenario) {
            let _ = c.delete_scenario(&summary.id);
            return Err(error);
        }
        state.rule_store.set_active_scenario(Some(&summary.id))?;
        Ok(summary)
    })
}

#[tauri::command]
pub fn rename_scenario(
    state: State<'_, AppState>,
    scenario_id: String,
    name: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    if scenario_id == GENERAL_SCENARIO_ID {
        return Err("the built-in General scenario cannot be renamed".to_string());
    }
    state.rule_store.rename_scenario(&scenario_id, &name)?;
    state.controller.with_history(history_tag, |c| {
        c.rename_scenario(&scenario_id, name).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn delete_scenario(
    state: State<'_, AppState>,
    scenario_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    if scenario_id == GENERAL_SCENARIO_ID {
        return Err("the built-in General scenario cannot be deleted".to_string());
    }
    state.rule_store.delete_scenario(&scenario_id)?;
    state.controller.with_history(history_tag, |c| {
        c.delete_scenario(&scenario_id).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn create_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    history_tag: HistoryTag,
) -> Result<RuleSummary, String> {
    state.controller.with_history(history_tag, |c| {
        let (rule, summary) = c.create_rule(&scenario_id).map_err(|e| e.to_string())?;
        if let Err(error) = state.rule_store.insert_rule(&scenario_id, &rule, None) {
            let _ = c.delete_rule(&scenario_id, &rule.id);
            return Err(error);
        }
        Ok(summary)
    })
}

#[tauri::command]
pub async fn update_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule: Rule,
    history_tag: HistoryTag,
) -> Result<RuleSummary, String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if controller.get_rule(&rule.id).is_none() {
            return Err("rule not found".to_string());
        }
        controller.with_history(history_tag, |c| {
            rule_store.update_rule(&scenario_id, &rule)?;
            c.update_rule(&scenario_id, rule).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("rule update task failed: {e}"))?
}

#[tauri::command]
pub fn delete_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    state.rule_store.delete_rule(&scenario_id, &rule_id)?;
    state.controller.with_history(history_tag, |c| {
        c.delete_rule(&scenario_id, &rule_id).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn delete_rules(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_ids: Vec<String>,
    history_tag: HistoryTag,
) -> Result<(), String> {
    // Persist first (idempotent DELETEs, so missing ids are harmless), then apply
    // the whole batch inside one history step so it undoes as a single action.
    for rule_id in &rule_ids {
        state.rule_store.delete_rule(&scenario_id, rule_id)?;
    }
    state.controller.with_history(history_tag, |c| {
        c.delete_rules(&scenario_id, &rule_ids)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub async fn duplicate_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_id: String,
    history_tag: HistoryTag,
) -> Result<RuleSummary, String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            let (rule, summary) = c
                .duplicate_rule(&scenario_id, &rule_id)
                .map_err(|e| e.to_string())?;
            if let Err(error) = rule_store.insert_rule(&scenario_id, &rule, Some(&rule_id)) {
                let _ = c.delete_rule(&scenario_id, &rule.id);
                return Err(error);
            }
            Ok(summary)
        })
    })
    .await
    .map_err(|e| format!("rule duplication task failed: {e}"))?
}

#[tauri::command]
pub fn reorder_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_id: String,
    to_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    state.controller.with_history(history_tag, |c| {
        let (previous, next) = c
            .reorder_rule(&scenario_id, &rule_id, &to_id)
            .map_err(|e| e.to_string())?;
        if let Err(error) = state.rule_store.reorder_rule(
            &scenario_id,
            &rule_id,
            previous.as_deref(),
            next.as_deref(),
        ) {
            if let Ok(autoresponder) = state.rule_store.load() {
                c.set_autoresponder(autoresponder);
            }
            return Err(error);
        }
        Ok(())
    })
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
    // A viewer shares settings.json with the capturing instance. Persisting its
    // (stale) snapshot would clobber the capturing instance's saved settings —
    // the same clobber the read-only RuleStore prevents for rules (issue #71).
    if state.viewer {
        return;
    }
    state.controller.set_settings(settings.clone());
    crate::persist::save_settings(&state.ca_dir, &settings);
}

#[tauri::command]
pub fn get_scripts(state: State<'_, AppState>) -> Vec<Script> {
    state.controller.get_scripts()
}

#[tauri::command]
pub fn set_scripts(state: State<'_, AppState>, scripts: Vec<Script>) -> Vec<ScriptDiagnostic> {
    // A viewer shares scripts.json with the capturing instance; don't let it
    // persist a stale snapshot (the same clobber guard as set_settings, issue #71).
    if state.viewer {
        return Vec::new();
    }
    let diagnostics = state.controller.set_scripts(scripts.clone());
    crate::persist::save_scripts(&state.ca_dir, &scripts);
    diagnostics
}

#[tauri::command]
pub fn check_script(state: State<'_, AppState>, source: String) -> Option<String> {
    state.controller.check_script(&source)
}

#[tauri::command]
pub async fn test_scenario(
    state: State<'_, AppState>,
    scenario_id: String,
    input: TestInput,
) -> Result<TestResult, String> {
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller
            .test_scenario(&scenario_id, &input)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("rule test task failed: {e}"))?
}

/// Seed Respond rules from the given captured flows into a scenario, persist
/// them transactionally and return lightweight identifiers.
#[tauri::command]
pub async fn mock_flows(
    state: State<'_, AppState>,
    ids: Vec<String>,
    scenario_id: Option<String>,
    history_tag: HistoryTag,
    progress: Channel<BulkMockEvent>,
) -> Result<MockResult, String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let total = ids.len();
        let batch = controller.prepare_mock_flows(&ids, scenario_id.as_deref(), |completed, total| {
            if completed == total || completed % 25 == 0 {
                let _ = progress.send(BulkMockEvent::Progress {
                    completed,
                    total,
                    phase: "generating",
                });
            }
        });
        let _ = progress.send(BulkMockEvent::Progress {
            completed: total,
            total,
            phase: "saving",
        });
        rule_store.apply_mock_batch(
            &batch.scenario_id,
            &batch.scenario_name,
            batch.create_scenario,
            &batch.rules,
        )?;
        let scenario_id = batch.scenario_id.clone();
        let created: Vec<RuleSummary> = batch.rules.iter().map(RuleSummary::from).collect();
        let result = controller
            .with_history(history_tag, |c| {
                c.commit_mock_batch(batch).map_err(|e| e.to_string())
            })?;
        for rules in created.chunks(100) {
            let _ = progress.send(BulkMockEvent::Created {
                scenario_id: scenario_id.clone(),
                rules: rules.to_vec(),
            });
        }
        if total == 0 {
            let _ = progress.send(BulkMockEvent::Progress {
                completed: 0,
                total: 0,
                phase: "generating",
            });
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("bulk mock task failed: {e}"))?
}

/// Re-issue the given (doc) flows without credentials to test public
/// availability, caching each verdict on its flow. Per-flow results stream back
/// on the live flow channel as each resolves; `progress` carries the running
/// count. Returns how many flows were actually checked (GET/HEAD only).
#[tauri::command]
pub async fn check_doc_availability(
    state: State<'_, AppState>,
    ids: Vec<String>,
    progress: Channel<AvailabilityProgress>,
) -> Result<usize, String> {
    let controller = state.controller.clone();
    // `move` so the closure owns the Channel (which is Send) rather than
    // borrowing it (which would demand Sync) — keeps the command future Send.
    let checked = controller
        .check_availability(&ids, move |completed, total| {
            let _ = progress.send(AvailabilityProgress { completed, total });
        })
        .await;
    Ok(checked)
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
    // The CA lives in the shared app-data dir. A viewer regenerating it would swap
    // the CA out from under the capturing instance (which keeps minting leaves with
    // the old in-memory CA), breaking HTTPS interception and invalidating the user's
    // installed trust. The controller's only guard is "proxy stopped", which is
    // always true in a viewer — so gate it here.
    if state.viewer {
        return Err("Regenerating the CA is disabled in viewer mode".to_string());
    }
    state
        .controller
        .regenerate_ca(&state.ca_dir)
        .await
        .map_err(|e| e.to_string())
}

/// Route the OS system proxy through Germi (Windows `WinINET` / GNOME / KDE).
#[tauri::command]
pub fn set_system_proxy(port: u16, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut prior) = state.prior_system_proxy.lock() {
        if prior.is_none() {
            *prior = Some(sysproxy::Sysproxy::get_system_proxy().unwrap_or_default());
        }
    }
    let sp = sysproxy::Sysproxy {
        enable: true,
        host: "127.0.0.1".to_string(),
        port,
        bypass: "localhost,127.0.0.1,::1".to_string(),
    };
    sp.set_system_proxy().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_system_proxy(state: State<'_, AppState>) -> Result<(), String> {
    if restore_prior_system_proxy(&state)? {
        return Ok(());
    }
    let mut sp = sysproxy::Sysproxy::get_system_proxy().map_err(|e| e.to_string())?;
    sp.enable = false;
    sp.set_system_proxy().map_err(|e| e.to_string())
}

pub fn restore_prior_system_proxy(state: &AppState) -> Result<bool, String> {
    let prior = match state.prior_system_proxy.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    let Some(prior) = prior else {
        return Ok(false);
    };
    prior.set_system_proxy().map_err(|e| e.to_string())?;
    Ok(true)
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
pub async fn search_bodies(
    state: State<'_, AppState>,
    pattern: String,
    side: SearchSide,
    regex: bool,
    candidates: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    // Decompress-and-scan over every stored body is heavy on a large capture; run
    // it on the blocking pool rather than the webview's IPC thread.
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.search_bodies(&pattern, side, regex, candidates.as_deref())
    })
    .await
    .map_err(|e| format!("body search task failed: {e}"))
}

/// Header search: return the ids of flows whose header table (name/value) matches.
#[tauri::command]
pub async fn search_headers(
    state: State<'_, AppState>,
    pattern: String,
    side: SearchSide,
    regex: bool,
    candidates: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.search_headers(&pattern, side, regex, candidates.as_deref())
    })
    .await
    .map_err(|e| format!("header search task failed: {e}"))
}

/// Deep rule search within one scenario: ids of rules whose `scope` fields match.
#[tauri::command]
pub fn search_rules(
    state: State<'_, AppState>,
    scenario_id: String,
    pattern: String,
    scope: RuleSearchScope,
) -> Vec<String> {
    state.controller.search_rules(&scenario_id, &pattern, scope)
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
    // Atomic write: overwriting an existing (possibly large) .germi that fails
    // mid-write would otherwise destroy the old capture and leave a truncated,
    // unopenable file. Stage to a temp sibling then rename.
    let bytes = state.controller.export_session();
    crate::persist::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Show the capture-file picker (.germi / .har / .saz) and read the chosen
/// file. Returns the bytes + lowercased extension, or `None` if cancelled.
fn pick_capture_file(app: &tauri::AppHandle) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Captures (.germi, .har, .saz)", &["germi", "har", "saz"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(Some((bytes, ext)))
}

/// Open a capture file — a `.germi` session, a HAR, or a Fiddler SAZ archive —
/// REPLACING the current traffic. Dispatches on the file extension. Returns the
/// number of flows loaded, or `None` if the user cancels the picker.
#[tauri::command]
pub async fn open_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<usize>, String> {
    let Some((bytes, ext)) = pick_capture_file(&app)? else {
        return Ok(None);
    };
    state
        .controller
        .open_capture(&bytes, &ext)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Append a capture file to the current traffic WITHOUT replacing it — loads a
/// reference session into the compare view's right side (issue #86). Returns
/// the appended flows' summaries, or `None` if the user cancels the picker.
#[tauri::command]
pub async fn append_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Vec<FlowSummary>>, String> {
    let Some((bytes, ext)) = pick_capture_file(&app)? else {
        return Ok(None);
    };
    state
        .controller
        .append_capture(&bytes, &ext)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Decode a capture file dragged from the OS file manager onto the webview.
/// An HTML5 file drop hands the frontend the File's *bytes* (base64 over IPC,
/// the same encoding `.germi` sessions already use), not a filesystem path like
/// the native picker — so there is nothing to `std::fs::read` here. `ext` (the
/// dropped file's extension) disambiguates HAR from `.germi` (both JSON).
fn decode_dropped_capture(data_b64: &str, ext: &str) -> Result<(Vec<u8>, String), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("could not decode the dropped file: {e}"))?;
    Ok((bytes, ext.to_ascii_lowercase()))
}

/// Open a capture file dropped onto the main window, REPLACING the current
/// traffic — the drag-drop counterpart of [`open_capture`] (issue #100). Returns
/// the number of flows loaded.
#[tauri::command]
pub async fn open_dropped_capture(
    state: State<'_, AppState>,
    data_b64: String,
    ext: String,
) -> Result<usize, String> {
    let (bytes, ext) = decode_dropped_capture(&data_b64, &ext)?;
    state
        .controller
        .open_capture(&bytes, &ext)
        .map_err(|e| e.to_string())
}

/// Append a capture file dropped onto the compare window WITHOUT replacing the
/// current traffic — the drag-drop counterpart of [`append_capture`] (issue
/// #100). Returns the appended flows' summaries.
#[tauri::command]
pub async fn append_dropped_capture(
    state: State<'_, AppState>,
    data_b64: String,
    ext: String,
) -> Result<Vec<FlowSummary>, String> {
    let (bytes, ext) = decode_dropped_capture(&data_b64, &ext)?;
    state
        .controller
        .append_capture(&bytes, &ext)
        .map_err(|e| e.to_string())
}

/// Byte-equality of two flows' decoded bodies, per side, for the compare view
/// (issue #86) — computed store-side so large bodies never cross the IPC bridge.
#[tauri::command]
pub async fn compare_flow_bodies(
    state: State<'_, AppState>,
    id_a: String,
    id_b: String,
) -> Result<Option<BodyComparison>, String> {
    // Decoding two up-to-64 MB bodies is heavy; keep it off the IPC thread.
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || controller.compare_bodies(&id_a, &id_b))
        .await
        .map_err(|e| format!("body compare task failed: {e}"))
}

/// Seed for the compare window (issue #86): which flow ids start on each side.
/// A hand-off mailbox between windows, not engine state — the compare window
/// resolves the ids to live summaries via `list_flows` when it reads it.
#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareSeed {
    pub left: Vec<String>,
    pub right: Vec<String>,
}

/// Store the compare-window seed. The main window calls this right before it
/// opens (or re-focuses + re-seeds) the `compare` window.
#[tauri::command]
pub fn set_compare_seed(state: State<'_, AppState>, seed: CompareSeed) {
    if let Ok(mut slot) = state.compare_seed.lock() {
        *slot = Some(seed);
    }
}

/// Read the compare-window seed (kept, not taken, so an F5 of the compare
/// window restores its starting point).
#[tauri::command]
pub fn get_compare_seed(state: State<'_, AppState>) -> Option<CompareSeed> {
    state.compare_seed.lock().ok().and_then(|slot| slot.clone())
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
    let bytes = controller.export_rules(scenario_id.as_deref());
    crate::persist::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
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
    history_tag: HistoryTag,
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
    let count = controller.with_history(history_tag, |c| {
        c.import_rules(&bytes, replace).map_err(|e| e.to_string())
    })?;
    state.rule_store.replace(&controller.get_autoresponder())?;
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
    crate::persist::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Import proxy settings from a JSON file, applying + persisting them. Returns
/// the new settings (or the unchanged current settings if cancelled).
#[tauri::command]
pub async fn import_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProxySettings, String> {
    // Don't let a viewer persist imported settings over the capturing instance's
    // shared settings.json (see `set_settings`).
    if state.viewer {
        return Err("Settings import is disabled in viewer mode".to_string());
    }
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

// ---- undo / redo history ----

/// Persist the autoresponder to `SQLite` after a mock undo/redo (traffic-only
/// steps touch memory + the live stream and need no persistence). A mock step's
/// `replace` is a full DB rewrite, so this runs on the blocking pool.
fn apply_history_step(
    controller: &proxy_core::ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    step: Option<HistoryStep>,
) -> Result<(), String> {
    if let Some(step) = step {
        if step.mock_changed {
            rule_store.replace(&controller.get_autoresponder())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn history_undo(state: State<'_, AppState>) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let step = controller.undo();
        apply_history_step(&controller, &rule_store, step)
    })
    .await
    .map_err(|e| format!("undo task failed: {e}"))?
}

#[tauri::command]
pub async fn history_redo(state: State<'_, AppState>) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let step = controller.redo();
        apply_history_step(&controller, &rule_store, step)
    })
    .await
    .map_err(|e| format!("redo task failed: {e}"))?
}
