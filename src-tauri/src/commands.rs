//! IPC commands exposed to the webview.
//!
//! Async commands clone the `Arc<ProxyController>` out of `State` *before*
//! awaiting so we never hold the state borrow across an `.await`. Live traffic
//! is pushed over a [`Channel`] in batches (see `subscribe_flows`) rather than
//! one IPC message per request — the bridge, not the proxy, is the bottleneck.

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use base64::Engine;
use proxy_core::{
    AutoResponderSummary, BodyComparison, CaptureImportHandle, CaptureImportProgress,
    CaptureImportStage, FlowDetail, FlowEvent, FlowFilterBatchResult, FlowFilterRequest,
    FlowSummary, GeneralRulesImportMode, HistoryStep, HistoryTag, MockBatch, MockResult,
    ProxyController, ProxySettings, Rule, RuleSearchScope, RuleSummary, Scenario, ScenarioSummary,
    Script, ScriptDiagnostic, SearchSide, TestInput, TestResult, CAPTURE_IMPORT_CANCELLED,
    GENERAL_SCENARIO_ID,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::broadcast::error::RecvError;

use crate::state::{AppState, FilterWindowLifecycle, SystemProxyOwnership};
use crate::system_proxy::{self, SystemProxyConfig};

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
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyStatus {
    pub active: bool,
    pub port: Option<u16>,
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
    let ip = if allow_remote {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
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
    // leave a dead one feeding a nulled-onmessage channel. The slot is plain data
    // (a task handle), so recover from a poisoned lock instead of silently
    // skipping the install (which would leave the traffic list dead forever).
    let mut slot = state
        .flow_forwarder
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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
/// file (HAR / SAZ) — clears the replay noise while keeping the
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
pub async fn get_rule(state: State<'_, AppState>, rule_id: String) -> Result<Option<Rule>, String> {
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || controller.get_rule(&rule_id))
        .await
        .map_err(|e| format!("rule lookup task failed: {e}"))
}

#[tauri::command]
pub async fn set_active_scenario(
    state: State<'_, AppState>,
    scenario_id: Option<String>,
    history_tag: HistoryTag,
) -> Result<(), String> {
    // Reject the built-in General scenario before touching the store — General
    // stacks via `set_general_active`, it is never the active scenario.
    if scenario_id.as_deref() == Some(GENERAL_SCENARIO_ID) {
        return Err("the built-in General scenario cannot be the active scenario".to_string());
    }
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        activate_scenario(
            &controller,
            &rule_store,
            scenario_id.as_deref(),
            history_tag,
        )
    })
    .await
    .map_err(|e| format!("scenario activation task failed: {e}"))?
}

/// Engine first so an unknown scenario id is rejected before it hits the DB.
/// `with_history` restores its before snapshot if persistence then fails.
fn activate_scenario(
    controller: &ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    scenario_id: Option<&str>,
    history_tag: HistoryTag,
) -> Result<(), String> {
    controller.with_history(history_tag, |c| {
        c.set_active_scenario(scenario_id)
            .map_err(|e| e.to_string())?;
        rule_store.set_active_scenario(scenario_id)
    })
}

/// Toggle the built-in General layer on/off and persist it as one rollback-safe
/// history operation.
#[tauri::command]
pub async fn set_general_active(
    state: State<'_, AppState>,
    active: bool,
    history_tag: HistoryTag,
) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            c.set_general_active(active).map_err(|e| e.to_string())?;
            rule_store.set_general_active(active)
        })
    })
    .await
    .map_err(|e| format!("general toggle task failed: {e}"))?
}

#[tauri::command]
pub async fn create_scenario(
    state: State<'_, AppState>,
    name: Option<String>,
    history_tag: HistoryTag,
) -> Result<ScenarioSummary, String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            let summary = c
                .create_scenario(name.as_deref())
                .map_err(|e| e.to_string())?;
            let scenario = Scenario {
                id: summary.id.clone(),
                name: summary.name.clone(),
                rules: Vec::new(),
            };
            rule_store.insert_scenario_and_activate(&scenario)?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| format!("scenario creation task failed: {e}"))?
}

#[tauri::command]
pub async fn rename_scenario(
    state: State<'_, AppState>,
    scenario_id: String,
    name: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    if scenario_id == GENERAL_SCENARIO_ID {
        return Err("the built-in General scenario cannot be renamed".to_string());
    }
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            c.rename_scenario(&scenario_id, name.clone())
                .map_err(|e| e.to_string())?;
            rule_store.rename_scenario(&scenario_id, &name)
        })
    })
    .await
    .map_err(|e| format!("scenario rename task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_scenario(
    state: State<'_, AppState>,
    scenario_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    if scenario_id == GENERAL_SCENARIO_ID {
        return Err("the built-in General scenario cannot be deleted".to_string());
    }
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            c.delete_scenario(&scenario_id).map_err(|e| e.to_string())?;
            rule_store.delete_scenario(&scenario_id)
        })
    })
    .await
    .map_err(|e| format!("scenario deletion task failed: {e}"))?
}

#[tauri::command]
pub async fn create_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    history_tag: HistoryTag,
) -> Result<RuleSummary, String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            let (rule, summary) = c.create_rule(&scenario_id).map_err(|e| e.to_string())?;
            rule_store.insert_rule(&scenario_id, &rule, None)?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| format!("rule creation task failed: {e}"))?
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
            let summary = c
                .update_rule(&scenario_id, rule.clone())
                .map_err(|e| e.to_string())?;
            rule_store.update_rule(&scenario_id, &rule)?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| format!("rule update task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            c.delete_rule(&scenario_id, &rule_id)
                .map_err(|e| e.to_string())?;
            rule_store.delete_rule(&scenario_id, &rule_id)
        })
    })
    .await
    .map_err(|e| format!("rule deletion task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_rules(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_ids: Vec<String>,
    history_tag: HistoryTag,
) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.with_history(history_tag, |c| {
            c.delete_rules(&scenario_id, &rule_ids)
                .map_err(|e| e.to_string())?;
            // A single SQLite transaction prevents a mid-batch write error from
            // persisting only a prefix of the selection.
            rule_store.delete_rules(&scenario_id, &rule_ids)
        })
    })
    .await
    .map_err(|e| format!("rule deletion task failed: {e}"))?
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
            rule_store.insert_rule(&scenario_id, &rule, Some(&rule_id))?;
            Ok(summary)
        })
    })
    .await
    .map_err(|e| format!("rule duplication task failed: {e}"))?
}

#[tauri::command]
pub async fn reorder_rule(
    state: State<'_, AppState>,
    scenario_id: String,
    rule_id: String,
    to_id: String,
    history_tag: HistoryTag,
) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reorder_rule_and_persist(
            &controller,
            &rule_store,
            &scenario_id,
            &rule_id,
            &to_id,
            history_tag,
        )
    })
    .await
    .map_err(|e| format!("rule reorder task failed: {e}"))?
}

fn reorder_rule_and_persist(
    controller: &ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    scenario_id: &str,
    rule_id: &str,
    to_id: &str,
    history_tag: HistoryTag,
) -> Result<(), String> {
    // The engine deliberately treats dropping a rule onto itself as a no-op and
    // returns no neighbors. Passing that pair to SQLite means "only item in the
    // list" and would assign sort_key 0, silently moving the durable rule while
    // live state stayed unchanged.
    if rule_id == to_id {
        return Ok(());
    }
    controller.with_history(history_tag, |c| {
        let (previous, next) = c
            .reorder_rule(scenario_id, rule_id, to_id)
            .map_err(|e| e.to_string())?;
        rule_store.reorder_rule(scenario_id, rule_id, previous.as_deref(), next.as_deref())?;
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
pub async fn set_settings(
    state: State<'_, AppState>,
    settings: ProxySettings,
) -> Result<(), String> {
    // A viewer shares settings.json with the capturing instance. Persisting its
    // (stale) snapshot would clobber the capturing instance's saved settings —
    // the same clobber the read-only RuleStore prevents for rules (issue #71).
    if state.viewer {
        return Err("Changing settings is disabled in viewer mode".to_string());
    }
    let _settings_op = state.settings_ops.lock().await;
    let controller = state.controller.clone();
    let ca_dir = state.ca_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::persist::save_settings(&ca_dir, &settings).map_err(|e| e.to_string())?;
        controller.set_settings(settings.clone());
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("settings save task failed: {e}"))?
}

#[tauri::command]
pub fn get_scripts(state: State<'_, AppState>) -> Vec<Script> {
    state.controller.get_scripts()
}

#[tauri::command]
pub async fn set_scripts(
    state: State<'_, AppState>,
    scripts: Vec<Script>,
) -> Result<Vec<ScriptDiagnostic>, String> {
    // A viewer shares scripts.json with the capturing instance; don't let it
    // persist a stale snapshot (the same clobber guard as set_settings, issue #71).
    if state.viewer {
        return Err("Changing scripts is disabled in viewer mode".to_string());
    }
    let _scripts_op = state.scripts_ops.lock().await;
    let controller = state.controller.clone();
    let ca_dir = state.ca_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::persist::save_scripts(&ca_dir, &scripts).map_err(|e| e.to_string())?;
        let diagnostics = controller.set_scripts(scripts.clone());
        Ok::<_, String>(diagnostics)
    })
    .await
    .map_err(|e| format!("scripts save task failed: {e}"))?
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
        let batch =
            controller.prepare_mock_flows(&ids, scenario_id.as_deref(), |completed, total| {
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
        let scenario_id = batch.scenario_id.clone();
        let created: Vec<RuleSummary> = batch.rules.iter().map(RuleSummary::from).collect();
        let result = commit_and_persist_mock_batch(&controller, &rule_store, batch, history_tag)?;
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

/// Engine commit first, disk second: persisting a batch the engine then rejects
/// would resurrect ghost rules on the next launch. `with_history` restores the
/// pre-commit engine snapshot when persistence fails, so neither side keeps a
/// partial batch.
fn commit_and_persist_mock_batch(
    controller: &ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    batch: MockBatch,
    history_tag: HistoryTag,
) -> Result<MockResult, String> {
    let scenario_id = batch.scenario_id.clone();
    let scenario_name = batch.scenario_name.clone();
    let create_scenario = batch.create_scenario;
    let rules = batch.rules.clone();
    controller.with_history(history_tag, |c| {
        let result = c.commit_mock_batch(batch).map_err(|e| e.to_string())?;
        rule_store
            .apply_mock_batch(&scenario_id, &scenario_name, create_scenario, &rules)
            .map_err(|e| format!("mock rules could not be persisted: {e}"))?;
        Ok(result)
    })
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
pub async fn export_ca(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
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
    let controller = state.controller.clone();
    let ca_dir = state.ca_dir.clone();
    controller
        .regenerate_ca(&ca_dir)
        .await
        .map_err(|e| e.to_string())
}

/// Route the OS system proxy through Germi (Windows `WinINET` / GNOME / KDE).
#[tauri::command]
pub async fn set_system_proxy(port: u16, state: State<'_, AppState>) -> Result<(), String> {
    // A viewer never binds the proxy port, so routing the OS proxy at it would
    // black-hole the system's traffic (same defense as `start_proxy`).
    if state.viewer {
        return Err("Changing the system proxy is disabled in viewer mode".to_string());
    }
    let bound = state.controller.bound_addr().await.ok_or_else(|| {
        "Cannot enable the system proxy while Germi's listener is stopped".to_string()
    })?;
    if bound.port() != port {
        return Err(format!(
            "Cannot route the system proxy to port {port}; Germi is listening on {}",
            bound.port()
        ));
    }
    let mut ownership = state
        .system_proxy_ownership
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let current = system_proxy::get()?;
    let captured_prior = prepare_system_proxy_takeover(&mut ownership, &current);
    let rollback_ownership = if captured_prior {
        SystemProxyOwnership::default()
    } else {
        ownership.clone()
    };
    let sp = SystemProxyConfig::germi(port);
    // Journal the transition before touching the OS. It retains the last
    // confirmed port and the pending target, so the next process recognizes
    // either side of a crash-interrupted platform call and can restore safely.
    ownership.pending_port = Some(port);
    if let Err(error) = crate::persist::save_system_proxy_ownership(&state.ca_dir, &ownership) {
        *ownership = rollback_ownership;
        return Err(format!("could not journal system proxy ownership: {error}"));
    }
    match system_proxy::set(&sp) {
        Ok(()) => {
            ownership.active_port = Some(port);
            ownership.pending_port = None;
            // The already-durable transition recognizes both crash outcomes, so
            // a failure to compact it is safe and can be retried on status/exit.
            if let Err(error) =
                crate::persist::save_system_proxy_ownership(&state.ca_dir, &ownership)
            {
                tracing::warn!("failed to finalize system-proxy ownership journal: {error}");
            }
            Ok(())
        }
        Err(error) => {
            // Some platform APIs can apply the setting and still report an
            // error. A successful read-back is the authoritative outcome; report
            // success so the ordinary toolbar path cannot leave the OS routed
            // through Germi while its toggle incorrectly remains off. Otherwise
            // a confirmed failed first takeover must not retain a false token.
            match system_proxy::get() {
                Ok(current) if is_germi_system_proxy(&current, port) => {
                    ownership.active_port = Some(port);
                    ownership.pending_port = None;
                    if let Err(error) =
                        crate::persist::save_system_proxy_ownership(&state.ca_dir, &ownership)
                    {
                        tracing::warn!(
                            "failed to finalize applied system-proxy ownership journal: {error}"
                        );
                    }
                    Ok(())
                }
                Ok(_) => {
                    *ownership = rollback_ownership;
                    let rollback = sync_system_proxy_ownership(&state.ca_dir, &ownership);
                    match rollback {
                        Ok(()) => Err(error.clone()),
                        Err(rollback_error) => Err(format!(
                            "{error}; could not roll back the ownership journal: {rollback_error}"
                        )),
                    }
                }
                Err(read_error) => Err(format!(
                    "{error}; could not verify whether the system proxy changed ({read_error}). \
                     The pending ownership journal was retained for safe recovery"
                )),
            }
        }
    }
}

fn sync_system_proxy_ownership(
    dir: &std::path::Path,
    ownership: &SystemProxyOwnership,
) -> Result<(), String> {
    if ownership.active_port.is_some() || ownership.pending_port.is_some() {
        crate::persist::save_system_proxy_ownership(dir, ownership)
    } else {
        crate::persist::clear_system_proxy_ownership(dir)
    }
    .map_err(|error| error.to_string())
}

fn is_germi_system_proxy(proxy: &SystemProxyConfig, owned_port: u16) -> bool {
    let host = proxy.host.trim();
    proxy.enable
        && proxy.port == owned_port
        && (host == "127.0.0.1"
            || host == "::1"
            || host == "[::1]"
            || host.eq_ignore_ascii_case("localhost"))
}

fn matching_owned_port(
    ownership: &SystemProxyOwnership,
    current: &SystemProxyConfig,
) -> Option<u16> {
    [ownership.active_port, ownership.pending_port]
        .into_iter()
        .flatten()
        .find(|port| is_germi_system_proxy(current, *port))
}

fn has_owned_port(ownership: &SystemProxyOwnership) -> bool {
    ownership.active_port.is_some() || ownership.pending_port.is_some()
}

fn read_owned_system_proxy(
    ownership: &SystemProxyOwnership,
    read: impl FnOnce() -> Result<SystemProxyConfig, String>,
) -> Result<Option<SystemProxyConfig>, String> {
    if !has_owned_port(ownership) {
        return Ok(None);
    }
    read().map(Some)
}

fn clear_incomplete_system_proxy_ownership(
    dir: &std::path::Path,
    ownership: &mut SystemProxyOwnership,
) {
    if *ownership == SystemProxyOwnership::default() {
        return;
    }
    *ownership = SystemProxyOwnership::default();
    if let Err(error) = crate::persist::clear_system_proxy_ownership(dir) {
        tracing::warn!("failed to clear incomplete system-proxy ownership journal: {error}");
    }
}

/// Ensure the saved restore target reflects the configuration Germi is taking
/// over right now. Re-pointing an already-owned proxy keeps the original
/// snapshot; reacquiring after an external replacement starts fresh from that
/// replacement instead of restoring stale state later.
fn prepare_system_proxy_takeover(
    ownership: &mut SystemProxyOwnership,
    current: &SystemProxyConfig,
) -> bool {
    if let Some(port) = matching_owned_port(ownership, current) {
        // Resolve a transition left by a crashed/restarted process before
        // staging the next one. The original restore target remains unchanged.
        ownership.active_port = Some(port);
        ownership.pending_port = None;
        return false;
    }
    *ownership = SystemProxyOwnership {
        prior: Some(current.clone()),
        active_port: None,
        pending_port: None,
    };
    true
}

/// Read the OS proxy plus this process's ownership token so a webview reload
/// restores the real toggle state instead of resetting it to false.
#[tauri::command]
pub fn system_proxy_status(state: State<'_, AppState>) -> Result<SystemProxyStatus, String> {
    let mut ownership = state
        .system_proxy_ownership
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // With no ownership token Germi cannot be the component that enabled the OS
    // proxy. Avoid probing unrelated platform state on every launch; in
    // particular, valid Windows hostname/protocol-map values were rejected by
    // `sysproxy` and used to leave all listener controls gated forever.
    let Some(current) = read_owned_system_proxy(&ownership, system_proxy::get)? else {
        clear_incomplete_system_proxy_ownership(&state.ca_dir, &mut ownership);
        return Ok(SystemProxyStatus {
            active: false,
            port: None,
        });
    };
    let before = ownership.clone();
    let active = if let Some(port) = matching_owned_port(&ownership, &current) {
        ownership.active_port = Some(port);
        ownership.pending_port = None;
        true
    } else {
        false
    };
    if active && *ownership != before {
        if let Err(error) = crate::persist::save_system_proxy_ownership(&state.ca_dir, &ownership) {
            tracing::warn!("failed to resolve system-proxy ownership transition: {error}");
        }
    } else if !active && has_owned_port(&ownership) {
        // The OS setting changed outside Germi. Drop the stale restore token now
        // so a later takeover snapshots that newer setting.
        *ownership = SystemProxyOwnership::default();
        if let Err(error) = crate::persist::clear_system_proxy_ownership(&state.ca_dir) {
            tracing::warn!("failed to clear stale system-proxy ownership journal: {error}");
        }
    }
    Ok(SystemProxyStatus {
        active,
        port: active.then_some(current.port),
    })
}

#[tauri::command]
pub fn clear_system_proxy(state: State<'_, AppState>) -> Result<(), String> {
    if state.viewer {
        return Err("Changing the system proxy is disabled in viewer mode".to_string());
    }
    // Never disable an unowned proxy as a fallback. If another application or
    // the user replaced Germi's exact endpoint, leave that configuration alone.
    restore_prior_system_proxy(&state).map(|_| ())
}

pub fn restore_prior_system_proxy(state: &AppState) -> Result<bool, String> {
    if state.viewer {
        return Ok(false);
    }
    let mut ownership = state
        .system_proxy_ownership
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(current) = read_owned_system_proxy(&ownership, system_proxy::get)? else {
        clear_incomplete_system_proxy_ownership(&state.ca_dir, &mut ownership);
        return Ok(false);
    };
    let restored = restore_saved_proxy(&mut ownership, &current, system_proxy::set);
    if restored.is_err()
        && system_proxy::get().is_ok_and(|after| matching_owned_port(&ownership, &after).is_none())
    {
        // As with takeover, some platform backends report an error after the OS
        // already applied the restore. Once the endpoint is no longer ours, the
        // important safety invariant is satisfied and the UI should switch off.
        *ownership = SystemProxyOwnership::default();
        if let Err(error) = crate::persist::clear_system_proxy_ownership(&state.ca_dir) {
            tracing::warn!("failed to clear restored system-proxy ownership journal: {error}");
        }
        return Ok(true);
    }
    if restored.is_ok() && !has_owned_port(&ownership) {
        if let Err(error) = crate::persist::clear_system_proxy_ownership(&state.ca_dir) {
            tracing::warn!("failed to clear system-proxy ownership journal: {error}");
        }
    }
    restored
}

fn restore_saved_proxy(
    ownership: &mut SystemProxyOwnership,
    current: &SystemProxyConfig,
    apply: impl FnOnce(&SystemProxyConfig) -> Result<(), String>,
) -> Result<bool, String> {
    let Some(_owned_port) = matching_owned_port(ownership, current) else {
        if has_owned_port(ownership) {
            // The OS proxy was replaced externally after Germi took ownership.
            // Abandon our saved snapshot instead of clobbering the newer choice.
            *ownership = SystemProxyOwnership::default();
            return Ok(false);
        }
        ownership.prior = None;
        return Ok(false);
    };
    // `prior` is always populated by a normal takeover, but an older/manual or
    // partially corrupted journal can contain only the owned port. Leaving that
    // endpoint enabled after the process exits would black-hole system traffic;
    // fail safe by disabling the exact proxy we still own.
    let fallback;
    let saved = if let Some(saved) = ownership.prior.as_ref() {
        saved
    } else {
        fallback = current.disabled_copy();
        &fallback
    };
    apply(saved)?;
    *ownership = SystemProxyOwnership::default();
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

/// Cookie search: match parsed request Cookie or response Set-Cookie pairs.
#[tauri::command]
pub async fn search_cookies(
    state: State<'_, AppState>,
    pattern: String,
    side: SearchSide,
    regex: bool,
    candidates: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let controller = state.controller.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.search_cookies(&pattern, side, regex, candidates.as_deref())
    })
    .await
    .map_err(|e| format!("cookie search task failed: {e}"))
}

/// Match several complete traffic-filter plans against one shared, bounded
/// candidate batch. A newer batch automatically cancels an older blocking
/// search; the frontend also cancels immediately when its filter generation
/// changes instead of waiting for the replacement debounce.
#[tauri::command]
pub async fn search_flow_filters(
    state: State<'_, AppState>,
    filters: Vec<FlowFilterRequest>,
) -> Result<FlowFilterBatchResult, String> {
    let controller = state.controller.clone();
    let epoch = state.flow_filter_search_epoch.clone();
    let token = epoch.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    tauri::async_runtime::spawn_blocking(move || {
        controller.search_flow_filters(&filters, || epoch.load(Ordering::Acquire) != token)
    })
    .await
    .map_err(|error| format!("traffic filter search task failed: {error}"))?
    .map_err(|error| format!("traffic filter snapshot failed: {error}"))
}

#[tauri::command]
pub fn cancel_flow_filter_search(state: State<'_, AppState>) {
    state
        .flow_filter_search_epoch
        .fetch_add(1, Ordering::AcqRel);
}

/// Bind the session from the live child webview itself. The command-injected
/// `Window` is its exact native dispatcher, so no pre-ready URL/runtime getter
/// is needed. A reload is idempotent; a different live session cannot replace
/// the active incarnation. The listener captures this exact incarnation so a
/// delayed old `Destroyed` event cannot close a replacement.
#[tauri::command]
pub fn register_filter_window_session(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<FilterWindowLifecycle, String> {
    if window.label() != "filter-builder" {
        return Err("only the filter window can announce filter readiness".to_string());
    }
    if session_id.trim().is_empty() {
        return Err("filter-window session id cannot be empty".to_string());
    }
    let (lifecycle, newly_bound) = state
        .filter_window_sessions
        .lock()
        .map_err(|_| "filter-window session registry is unavailable".to_string())?
        .register(session_id)
        .map_err(str::to_string)?;
    if newly_bound {
        let destroyed_app = app.clone();
        let destroyed_lifecycle = lifecycle.clone();
        window.on_window_event(move |event| {
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            let closed = destroyed_app.try_state::<AppState>().is_some_and(|state| {
                state
                    .filter_window_sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .close(&destroyed_lifecycle)
            });
            if closed {
                let _ =
                    destroyed_app.emit("germi://filter-window-closed", destroyed_lifecycle.clone());
            }
        });
    }
    Ok(lifecycle)
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

/// Save the current traffic as a HAR 1.2 archive — the interchange format any
/// HTTP tool can open (issue #113). Returns false if cancelled.
#[tauri::command]
pub async fn save_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    include_rules: bool,
) -> Result<bool, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("HAR archive", &["har"])
        .set_file_name("session.har")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    // Atomic write: overwriting an existing (possibly large) capture that fails
    // mid-write would otherwise destroy the old file and leave a truncated,
    // unopenable one. Stage to a temp sibling then rename.
    let bytes = state.controller.export_har(include_rules);
    crate::persist::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// What an open delivered: the flow count plus, for a Germi-written HAR that
/// embeds mock rules, a per-scenario preview the UI turns into an import offer
/// (issue #113). The bundle itself waits in `AppState::pending_har_rules` for
/// `apply_har_rules`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedCapture {
    pub count: usize,
    pub embedded_rules: Option<Vec<proxy_core::ScenarioPreview>>,
}

/// Bounded side channel for a capture import. Progress messages are tiny and
/// throttled; Compare receives its exact appended summaries in small batches
/// after the atomic commit instead of one giant invoke response.
#[derive(Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CaptureImportEvent {
    Started {
        operation_id: u64,
    },
    Progress {
        operation_id: u64,
        stage: CaptureImportStage,
        completed: u64,
        total: Option<u64>,
        cancelable: bool,
    },
    Summaries {
        operation_id: u64,
        batch_index: u64,
        summaries: Vec<FlowSummary>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCapture {
    pub count: usize,
}

struct CaptureProgressSender {
    operation_id: u64,
    channel: Channel<CaptureImportEvent>,
    last_stage: Option<CaptureImportStage>,
    last_completed: u64,
    last_sent: Instant,
}

impl CaptureProgressSender {
    fn new(operation_id: u64, channel: Channel<CaptureImportEvent>) -> Self {
        Self {
            operation_id,
            channel,
            last_stage: None,
            last_completed: 0,
            last_sent: Instant::now(),
        }
    }

    /// Keep the UI fresh without turning byte/item callbacks into an IPC flood.
    /// Stage boundaries and exact completions are always delivered.
    fn report(&mut self, progress: CaptureImportProgress) -> bool {
        if self
            .last_stage
            .is_some_and(|stage| (progress.stage as u8) < (stage as u8))
            || self.last_stage == Some(progress.stage) && progress.completed < self.last_completed
        {
            return true;
        }
        let stage_changed = self.last_stage != Some(progress.stage);
        let completed = progress.total == Some(progress.completed);
        if !stage_changed && !completed && self.last_sent.elapsed() < Duration::from_millis(75) {
            return true;
        }
        if self
            .channel
            .send(CaptureImportEvent::Progress {
                operation_id: self.operation_id,
                stage: progress.stage,
                completed: progress.completed,
                total: progress.total,
                cancelable: progress.cancelable,
            })
            .is_err()
        {
            return false;
        }
        self.last_stage = Some(progress.stage);
        self.last_completed = progress.completed;
        self.last_sent = Instant::now();
        true
    }
}

/// Park the embedded `_germiRules` bundle already extracted by proxy-core's
/// single HAR parse. Version the mailbox so out-of-order shell completions from
/// overlapping imports cannot restore an older offer.
fn stash_embedded_rules(
    pending: &std::sync::Mutex<crate::state::PendingHarRules>,
    operation_id: u64,
    bundle: Option<Vec<u8>>,
) -> Option<Vec<proxy_core::ScenarioPreview>> {
    let preview = bundle.as_deref().and_then(proxy_core::preview_rules);
    if let Ok(mut slot) = pending.lock() {
        if operation_id < slot.import_id {
            return None;
        }
        slot.import_id = operation_id;
        slot.bundle = if preview.is_some() { bundle } else { None };
    }
    preview
}

/// Show the capture-file picker (.har / .saz). Returns the chosen native path,
/// or `None` if cancelled.
fn pick_capture_file(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Captures (.har, .saz)", &["har", "saz"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    picked.into_path().map(Some).map_err(|e| e.to_string())
}

fn read_capture_file(
    path: &Path,
    handle: &CaptureImportHandle,
    progress: &mut CaptureProgressSender,
) -> Result<(Vec<u8>, String), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let total = file.metadata().ok().map(|metadata| metadata.len());
    if !progress.report(CaptureImportProgress {
        stage: CaptureImportStage::Reading,
        completed: 0,
        total,
        cancelable: true,
    }) {
        return Err(CAPTURE_IMPORT_CANCELLED.to_string());
    }
    let capacity = total
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        if handle.is_cancelled() {
            return Err(CAPTURE_IMPORT_CANCELLED.to_string());
        }
        let read = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if !progress.report(CaptureImportProgress {
            stage: CaptureImportStage::Reading,
            completed: bytes.len() as u64,
            total,
            cancelable: true,
        }) {
            return Err(CAPTURE_IMPORT_CANCELLED.to_string());
        }
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok((bytes, ext))
}

fn claim_capture_import(
    controller: &ProxyController,
    operation_id: u64,
    channel: Channel<CaptureImportEvent>,
) -> Result<(CaptureImportHandle, CaptureProgressSender), String> {
    let handle = controller
        .claim_capture_import(operation_id)
        .map_err(|error| error.to_string())?;
    if channel
        .send(CaptureImportEvent::Started { operation_id })
        .is_err()
    {
        controller.finish_capture_import(&handle);
        return Err(CAPTURE_IMPORT_CANCELLED.to_string());
    }
    Ok((
        handle.clone(),
        CaptureProgressSender::new(operation_id, channel),
    ))
}

fn decode_dropped_capture(
    data_b64: &str,
    ext: &str,
    handle: &CaptureImportHandle,
    progress: &mut CaptureProgressSender,
) -> Result<(Vec<u8>, String), String> {
    const CHUNK: usize = 256 * 1024;
    let total = data_b64.len() as u64;
    let mut bytes = Vec::with_capacity(data_b64.len().saturating_mul(3) / 4);
    if !progress.report(CaptureImportProgress {
        stage: CaptureImportStage::Decoding,
        completed: 0,
        total: Some(total),
        cancelable: true,
    }) {
        return Err(CAPTURE_IMPORT_CANCELLED.to_string());
    }
    for (index, encoded) in data_b64.as_bytes().chunks(CHUNK).enumerate() {
        if handle.is_cancelled() {
            return Err(CAPTURE_IMPORT_CANCELLED.to_string());
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| format!("could not decode the dropped file: {e}"))?;
        bytes.extend_from_slice(&decoded);
        let completed = ((index + 1) * CHUNK).min(data_b64.len()) as u64;
        if !progress.report(CaptureImportProgress {
            stage: CaptureImportStage::Decoding,
            completed,
            total: Some(total),
            cancelable: true,
        }) {
            return Err(CAPTURE_IMPORT_CANCELLED.to_string());
        }
    }
    Ok((bytes, ext.to_ascii_lowercase()))
}

fn run_capture_bytes(
    controller: &ProxyController,
    handle: &CaptureImportHandle,
    bytes: &[u8],
    ext: &str,
    replace: bool,
    progress: &mut CaptureProgressSender,
) -> Result<proxy_core::CaptureImportResult, String> {
    controller
        .run_capture_import(handle, bytes, ext, replace, |update| {
            progress.report(update)
        })
        .map_err(|error| error.to_string())
}

enum PathImportError {
    Read(String),
    Import(String),
}

fn reserve_capture_import_delivery(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    operation_id: u64,
) {
    acknowledgements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            operation_id,
            crate::state::CaptureImportBatchDelivery::Reserved,
        );
}

fn abandon_capture_import_delivery(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    operation_id: u64,
) {
    acknowledgements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&operation_id);
}

async fn run_path_import(
    controller: std::sync::Arc<ProxyController>,
    handle: CaptureImportHandle,
    mut progress: CaptureProgressSender,
    path: PathBuf,
    replace: bool,
    delivery: Option<crate::state::CaptureImportBatchAcks>,
) -> Result<(u64, proxy_core::CaptureImportResult), String> {
    let display = path.display().to_string();
    let operation_id = handle.id();
    if let Some(delivery) = delivery.as_ref() {
        reserve_capture_import_delivery(delivery, operation_id);
    }
    let worker_controller = controller.clone();
    let worker_handle = handle.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let (bytes, ext) = match read_capture_file(&path, &worker_handle, &mut progress) {
            Ok(read) => read,
            Err(error) => {
                worker_controller.finish_capture_import(&worker_handle);
                return Err(PathImportError::Read(error));
            }
        };
        run_capture_bytes(
            &worker_controller,
            &worker_handle,
            &bytes,
            &ext,
            replace,
            &mut progress,
        )
        .map_err(PathImportError::Import)
    })
    .await;
    let result = match joined {
        Ok(Ok(result)) => Ok((operation_id, result)),
        Ok(Err(PathImportError::Read(error))) => {
            Err(format!("Could not open capture '{display}': {error}"))
        }
        Ok(Err(PathImportError::Import(error))) if replace => {
            Err(format!("Could not open capture '{display}': {error}"))
        }
        Ok(Err(PathImportError::Import(error))) => Err(error),
        Err(error) => {
            controller.finish_capture_import(&handle);
            Err(format!(
                "Could not open capture '{display}': import task failed: {error}"
            ))
        }
    };
    if result.is_err() {
        if let Some(delivery) = delivery.as_ref() {
            abandon_capture_import_delivery(delivery, operation_id);
        }
    }
    result
}

async fn run_dropped_import(
    controller: std::sync::Arc<ProxyController>,
    operation_id: u64,
    data_b64: String,
    ext: String,
    replace: bool,
    channel: Channel<CaptureImportEvent>,
    delivery: Option<crate::state::CaptureImportBatchAcks>,
) -> Result<(u64, proxy_core::CaptureImportResult), String> {
    let (handle, mut progress) = claim_capture_import(&controller, operation_id, channel)?;
    if let Some(delivery) = delivery.as_ref() {
        reserve_capture_import_delivery(delivery, operation_id);
    }
    let worker_controller = controller.clone();
    let worker_handle = handle.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let (bytes, ext) =
            match decode_dropped_capture(&data_b64, &ext, &worker_handle, &mut progress) {
                Ok(decoded) => decoded,
                Err(error) => {
                    worker_controller.finish_capture_import(&worker_handle);
                    return Err(error);
                }
            };
        run_capture_bytes(
            &worker_controller,
            &worker_handle,
            &bytes,
            &ext,
            replace,
            &mut progress,
        )
    })
    .await;
    let result = match joined {
        Ok(result) => result.map(|result| (operation_id, result)),
        Err(error) => {
            controller.finish_capture_import(&handle);
            Err(format!("capture import task failed: {error}"))
        }
    };
    if result.is_err() {
        if let Some(delivery) = delivery.as_ref() {
            abandon_capture_import_delivery(delivery, operation_id);
        }
    }
    result
}

async fn stream_imported_summaries(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    channel: &Channel<CaptureImportEvent>,
    operation_id: u64,
    summaries: &[FlowSummary],
) -> Result<(), String> {
    stream_imported_summaries_with_timeout(
        acknowledgements,
        channel,
        operation_id,
        summaries,
        Duration::from_secs(30),
    )
    .await
}

async fn stream_imported_summaries_with_timeout(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    channel: &Channel<CaptureImportEvent>,
    operation_id: u64,
    summaries: &[FlowSummary],
    ack_timeout: Duration,
) -> Result<(), String> {
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::unbounded_channel();
    let expected = std::sync::Arc::new(std::sync::Mutex::new(
        crate::state::CaptureImportBatchExpectation::default(),
    ));
    {
        let mut deliveries = acknowledgements
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match deliveries.remove(&operation_id) {
            Some(crate::state::CaptureImportBatchDelivery::Reserved) => {
                deliveries.insert(
                    operation_id,
                    crate::state::CaptureImportBatchDelivery::Waiting(
                        crate::state::CaptureImportBatchAck {
                            expected: expected.clone(),
                            sender: ack_tx,
                        },
                    ),
                );
            }
            Some(crate::state::CaptureImportBatchDelivery::Cancelled) => {
                return Err("Compare summary delivery was cancelled".to_string());
            }
            Some(crate::state::CaptureImportBatchDelivery::Waiting(_)) | None => {
                return Err("Compare summary delivery was not reserved".to_string());
            }
        }
    }

    let result = async {
        for (batch_index, chunk) in summaries.chunks(200).enumerate() {
            let batch_index = batch_index as u64;
            *expected
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                crate::state::CaptureImportBatchExpectation {
                    batch_index,
                    acknowledged: false,
                };
            channel
                .send(CaptureImportEvent::Summaries {
                    operation_id,
                    batch_index,
                    summaries: chunk.to_vec(),
                })
                .map_err(|error| format!("could not deliver imported requests: {error}"))?;

            loop {
                let acknowledged = tokio::time::timeout(ack_timeout, ack_rx.recv())
                    .await
                    .map_err(|_| {
                        format!(
                            "Requests were imported, but Compare did not acknowledge batch {} within {ack_timeout:?}",
                            batch_index + 1,
                        )
                    })?
                    .ok_or_else(|| "Compare summary delivery was cancelled".to_string())?;
                if acknowledged == batch_index {
                    break;
                }
            }
        }
        Ok(())
    }
    .await;

    acknowledgements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&operation_id);
    result
}

fn acknowledge_capture_import_batch(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    operation_id: u64,
    batch_index: u64,
) -> bool {
    let acknowledgements = acknowledgements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(crate::state::CaptureImportBatchDelivery::Waiting(acknowledgement)) =
        acknowledgements.get(&operation_id)
    else {
        return false;
    };
    let mut expected = acknowledgement
        .expected
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if expected.batch_index != batch_index || expected.acknowledged {
        return false;
    }
    if acknowledgement.sender.send(batch_index).is_err() {
        return false;
    }
    expected.acknowledged = true;
    true
}

fn cancel_capture_import_delivery(
    acknowledgements: &crate::state::CaptureImportBatchAcks,
    operation_id: u64,
) -> bool {
    let mut acknowledgements = acknowledgements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match acknowledgements.remove(&operation_id) {
        Some(crate::state::CaptureImportBatchDelivery::Reserved) => {
            acknowledgements.insert(
                operation_id,
                crate::state::CaptureImportBatchDelivery::Cancelled,
            );
            true
        }
        Some(crate::state::CaptureImportBatchDelivery::Waiting(_)) => true,
        Some(crate::state::CaptureImportBatchDelivery::Cancelled) => {
            acknowledgements.insert(
                operation_id,
                crate::state::CaptureImportBatchDelivery::Cancelled,
            );
            false
        }
        None => false,
    }
}

#[tauri::command]
pub fn ack_capture_import_batch(
    state: State<'_, AppState>,
    operation_id: u64,
    batch_index: u64,
) -> bool {
    acknowledge_capture_import_batch(&state.capture_import_batch_acks, operation_id, batch_index)
}

/// Reserve a monotonic import intent before the frontend opens a picker or
/// reads a dropped file. This does not disturb an active import until the token
/// is claimed by exactly one command; late commands with older tokens reject.
#[tauri::command]
pub fn reserve_capture_import(state: State<'_, AppState>) -> u64 {
    state.controller.reserve_capture_import()
}

/// Take the one-shot launch mailbox before reserving. An ordinary reload with
/// no launch path therefore cannot disturb a real import in another window.
fn prepare_launch_capture_import(
    controller: &ProxyController,
    launch_capture: &crate::launch::PendingCapture,
    prepared_launch: &std::sync::Mutex<Option<crate::state::PreparedLaunchCapture>>,
) -> Result<Option<u64>, String> {
    let Some(path) = launch_capture.take()? else {
        return Ok(None);
    };
    let operation_id = controller.reserve_capture_import();
    prepared_launch
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .replace(crate::state::PreparedLaunchCapture { operation_id, path });
    Ok(Some(operation_id))
}

#[tauri::command]
pub fn reserve_launch_capture_import(state: State<'_, AppState>) -> Result<Option<u64>, String> {
    prepare_launch_capture_import(
        &state.controller,
        &state.launch_capture,
        &state.prepared_launch_capture,
    )
}

/// Open a capture file — a HAR or a Fiddler SAZ archive —
/// REPLACING the current traffic. Dispatches on the file extension. Returns the
/// number of flows loaded, or `None` if the user cancels the picker.
#[tauri::command]
pub async fn open_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    operation_id: u64,
    progress: Channel<CaptureImportEvent>,
) -> Result<Option<OpenedCapture>, String> {
    let controller = state.controller.clone();
    let pending_rules = state.pending_har_rules.clone();
    let path = match pick_capture_file(&app) {
        Ok(Some(path)) => path,
        Ok(None) => {
            controller.cancel_capture_import(operation_id);
            return Ok(None);
        }
        Err(error) => {
            controller.cancel_capture_import(operation_id);
            return Err(error);
        }
    };
    let (handle, progress) = claim_capture_import(&controller, operation_id, progress)?;
    let (operation_id, result) =
        run_path_import(controller, handle, progress, path, true, None).await?;
    let embedded_rules = stash_embedded_rules(&pending_rules, operation_id, result.embedded_rules);
    Ok(Some(OpenedCapture {
        count: result.summaries.len(),
        embedded_rules,
    }))
}

/// A file supplied by the OS at process launch. The path is taken from the
/// Rust mailbox before I/O so malformed/missing files report once through the
/// same frontend error toast and cannot loop on a webview reload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCapture {
    opened: OpenedCapture,
    viewer: bool,
}

#[tauri::command]
pub async fn consume_launch_capture(
    state: State<'_, AppState>,
    operation_id: u64,
    progress: Channel<CaptureImportEvent>,
) -> Result<Option<LaunchCapture>, String> {
    let controller = state.controller.clone();
    let pending_rules = state.pending_har_rules.clone();
    let prepared_launch = state.prepared_launch_capture.clone();
    let viewer = state.viewer;
    let prepared = {
        let mut prepared = prepared_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        prepared.take_if(|prepared| prepared.operation_id == operation_id)
    };
    let Some(prepared) = prepared else {
        controller.cancel_capture_import(operation_id);
        return Err(CAPTURE_IMPORT_CANCELLED.to_string());
    };
    let path = prepared.path;
    let (handle, progress) = claim_capture_import(&controller, operation_id, progress)?;
    let (operation_id, result) =
        run_path_import(controller, handle, progress, path, true, None).await?;
    let opened = OpenedCapture {
        count: result.summaries.len(),
        embedded_rules: stash_embedded_rules(&pending_rules, operation_id, result.embedded_rules),
    };
    Ok(Some(LaunchCapture { opened, viewer }))
}

/// Append a capture file to the current traffic WITHOUT replacing it — loads a
/// reference session into the compare view's right side (issue #86). Returns
/// the appended flow count, or `None` if the user cancels the picker. The invoke
/// remains pending until every bounded summary batch is acknowledged; its
/// settlement is the authoritative terminal signal for the frontend.
#[tauri::command]
pub async fn append_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    operation_id: u64,
    progress: Channel<CaptureImportEvent>,
) -> Result<Option<ImportedCapture>, String> {
    let controller = state.controller.clone();
    let acknowledgements = state.capture_import_batch_acks.clone();
    let summary_channel = progress.clone();
    let path = match pick_capture_file(&app) {
        Ok(Some(path)) => path,
        Ok(None) => {
            controller.cancel_capture_import(operation_id);
            return Ok(None);
        }
        Err(error) => {
            controller.cancel_capture_import(operation_id);
            return Err(error);
        }
    };
    let (handle, progress) = claim_capture_import(&controller, operation_id, progress)?;
    let (operation_id, result) = run_path_import(
        controller,
        handle,
        progress,
        path,
        false,
        Some(acknowledgements.clone()),
    )
    .await?;
    stream_imported_summaries(
        &acknowledgements,
        &summary_channel,
        operation_id,
        &result.summaries,
    )
    .await?;
    Ok(Some(ImportedCapture {
        count: result.summaries.len(),
    }))
}

/// Open a capture file dropped onto the main window, REPLACING the current
/// traffic — the drag-drop counterpart of [`open_capture`] (issue #100). Returns
/// the number of flows loaded.
#[tauri::command]
pub async fn open_dropped_capture(
    state: State<'_, AppState>,
    operation_id: u64,
    data_b64: String,
    ext: String,
    progress: Channel<CaptureImportEvent>,
) -> Result<OpenedCapture, String> {
    let controller = state.controller.clone();
    let pending_rules = state.pending_har_rules.clone();
    let (operation_id, result) = run_dropped_import(
        controller,
        operation_id,
        data_b64,
        ext,
        true,
        progress,
        None,
    )
    .await?;
    Ok(OpenedCapture {
        count: result.summaries.len(),
        embedded_rules: stash_embedded_rules(&pending_rules, operation_id, result.embedded_rules),
    })
}

/// Append a capture file dropped onto the compare window WITHOUT replacing the
/// current traffic — the drag-drop counterpart of [`append_capture`] (issue
/// #100). Returns the appended flows' summaries.
#[tauri::command]
pub async fn append_dropped_capture(
    state: State<'_, AppState>,
    operation_id: u64,
    data_b64: String,
    ext: String,
    progress: Channel<CaptureImportEvent>,
) -> Result<ImportedCapture, String> {
    let controller = state.controller.clone();
    let acknowledgements = state.capture_import_batch_acks.clone();
    let summary_channel = progress.clone();
    let (operation_id, result) = run_dropped_import(
        controller,
        operation_id,
        data_b64,
        ext,
        false,
        progress,
        Some(acknowledgements.clone()),
    )
    .await?;
    stream_imported_summaries(
        &acknowledgements,
        &summary_channel,
        operation_id,
        &result.summaries,
    )
    .await?;
    Ok(ImportedCapture {
        count: result.summaries.len(),
    })
}

#[tauri::command]
pub fn cancel_capture_import(state: State<'_, AppState>, operation_id: u64) -> bool {
    let parsing = state.controller.cancel_capture_import(operation_id);
    let prepared_launch = state
        .prepared_launch_capture
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take_if(|prepared| prepared.operation_id == operation_id)
        .is_some();
    let delivery = cancel_capture_import_delivery(&state.capture_import_batch_acks, operation_id);
    parsing || prepared_launch || delivery
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
    *state
        .compare_seed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(seed);
}

/// Read the compare-window seed (kept, not taken, so an F5 of the compare
/// window restores its starting point).
#[tauri::command]
pub fn get_compare_seed(state: State<'_, AppState>) -> Option<CompareSeed> {
    state
        .compare_seed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Export autoresponder scenarios to a rules-only HAR (zero entries, rules in
/// `_germiRules`). With `scenario_id` only that scenario is written; otherwise
/// the whole config. Returns false if the user cancels.
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
        .add_filter("HAR archive", &["har"])
        .set_file_name("mock-rules.har")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = controller.export_rules(scenario_id.as_deref());
    crate::persist::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Pick and validate a standalone rules file, then park its bytes until the UI
/// applies it. The preview retains whether a source scenario is the built-in
/// General layer so issue #122's destination prompt happens before mutation.
#[tauri::command]
pub async fn peek_rules_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Vec<proxy_core::ScenarioPreview>>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter(
            "Mock rules (.har, .farx, .germi-rules)",
            &["har", "farx", "germi-rules"],
        )
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let preview = proxy_core::preview_rules_file(&bytes).map_err(|e| e.to_string())?;
    *state
        .pending_rules_import
        .lock()
        .map_err(|_| "Pending rules import lock is poisoned".to_string())? = Some(bytes);
    Ok(Some(preview))
}

fn import_rules_and_persist(
    controller: &ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    bytes: &[u8],
    replace: bool,
    general_mode: GeneralRulesImportMode,
    history_tag: HistoryTag,
) -> Result<usize, String> {
    controller.with_history(history_tag, |c| {
        let count = c
            .import_rules_with_general(bytes, replace, general_mode)
            .map_err(|e| e.to_string())?;
        rule_store
            .replace(&c.get_autoresponder())
            .map_err(|e| format!("imported rules could not be persisted: {e}"))?;
        Ok::<usize, String>(count)
    })
}

/// Apply the standalone rules file parked by [`peek_rules_import`]. Ordinary
/// scenarios append or replace as requested; a source General layer follows
/// the user's explicit issue #122 choice. The bytes are consumed only after
/// both the live mutation and `SQLite` transaction succeed.
#[tauri::command]
pub async fn apply_rules_import(
    state: State<'_, AppState>,
    replace: bool,
    general_mode: GeneralRulesImportMode,
    history_tag: HistoryTag,
) -> Result<usize, String> {
    let controller = state.controller.clone();
    let mut pending = state
        .pending_rules_import
        .lock()
        .map_err(|_| "Pending rules import lock is poisoned".to_string())?;
    let count = {
        let bytes = pending
            .as_deref()
            .ok_or_else(|| "No pending rules file to import".to_string())?;
        import_rules_and_persist(
            &controller,
            &state.rule_store,
            bytes,
            replace,
            general_mode,
            history_tag,
        )?
    };
    pending.take();
    Ok(count)
}

/// Import the mock-rules bundle embedded in the last opened HAR (parked by
/// `stash_embedded_rules` after the user accepted the offer). Ordinary
/// scenarios always append; an included General layer follows the same
/// destination choice as a standalone rules import.
#[tauri::command]
pub async fn apply_har_rules(
    state: State<'_, AppState>,
    general_mode: GeneralRulesImportMode,
    history_tag: HistoryTag,
) -> Result<usize, String> {
    let controller = state.controller.clone();
    let mut pending = state
        .pending_har_rules
        .lock()
        .map_err(|_| "Pending mock rules lock is poisoned".to_string())?;
    let count = {
        let bytes = pending
            .bundle
            .as_deref()
            .ok_or_else(|| "No pending mock rules to import".to_string())?;
        import_rules_and_persist(
            &controller,
            &state.rule_store,
            bytes,
            false,
            general_mode,
            history_tag,
        )?
    };
    // Consume the parked bundle only after both the live import and SQLite
    // transaction succeed, so a persistence error remains retryable.
    pending.bundle = None;
    Ok(count)
}

/// Section summaries of the CURRENT settings — drives the export checklist.
#[tauri::command]
pub fn get_settings_sections(state: State<'_, AppState>) -> Vec<proxy_core::SectionSummary> {
    proxy_core::section_summaries(&state.controller.get_settings())
}

/// Export the selected settings sections to a user-chosen JSON file
/// (issue #112: partial export via checklist).
#[tauri::command]
pub async fn export_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sections: Vec<String>,
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
    let text = proxy_core::export_sections(&state.controller.get_settings(), &sections);
    crate::persist::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Phase 1 of a settings import: pick a file, validate it, and return which
/// sections it carries so the user can review them before anything is applied.
/// The file's text is parked on `AppState` for `apply_settings_import`.
/// Returns `None` if the picker was cancelled.
#[tauri::command]
pub async fn peek_settings_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Vec<proxy_core::SectionSummary>>, String> {
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
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let preview = proxy_core::import_preview(&text)?;
    *state
        .pending_settings_import
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(text);
    Ok(Some(preview))
}

/// Phase 2: merge the selected sections of the previously peeked file into the
/// current settings, apply + persist them, and return the result. Sections the
/// user unchecked — and fields the file doesn't carry — keep their values.
#[tauri::command]
pub async fn apply_settings_import(
    state: State<'_, AppState>,
    sections: Vec<String>,
) -> Result<ProxySettings, String> {
    if state.viewer {
        return Err("Settings import is disabled in viewer mode".to_string());
    }
    let _settings_op = state.settings_ops.lock().await;
    let mut pending = state
        .pending_settings_import
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let text = pending
        .as_deref()
        .ok_or_else(|| "No settings file pending — pick one first".to_string())?;
    let merged = proxy_core::merge_import(&state.controller.get_settings(), text, &sections)?;
    crate::persist::save_settings(&state.ca_dir, &merged).map_err(|e| e.to_string())?;
    state.controller.set_settings(merged.clone());
    pending.take();
    Ok(merged)
}

// ---- undo / redo history ----

/// Persist the autoresponder to `SQLite` after a mock undo/redo (traffic-only
/// steps touch memory + the live stream and need no persistence). A mock step's
/// `replace` is a full DB rewrite, so this runs on the blocking pool.
fn apply_history_step(
    controller: &proxy_core::ProxyController,
    rule_store: &crate::rule_store::RuleStore,
    step: &HistoryStep,
) -> Result<(), String> {
    if step.mock_changed {
        rule_store.replace(&controller.get_autoresponder())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn history_undo(state: State<'_, AppState>) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller
            .undo_and_then(|current, step| apply_history_step(current, &rule_store, step))
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("undo task failed: {e}"))?
}

#[tauri::command]
pub async fn history_redo(state: State<'_, AppState>) -> Result<(), String> {
    let controller = state.controller.clone();
    let rule_store = state.rule_store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller
            .redo_and_then(|current, step| apply_history_step(current, &rule_store, step))
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("redo task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule_store::RuleStore;
    use proxy_core::{Action, AutoResponder, CertAuthority, MatchKind, Matcher};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("germi-commands-{name}-{nonce}"))
    }

    fn controller() -> ProxyController {
        ProxyController::new(CertAuthority::generate().expect("generate in-memory CA"))
    }

    fn tag() -> HistoryTag {
        HistoryTag::new("test", None)
    }

    #[test]
    fn filter_window_registration_never_inspects_a_pre_ready_webview_url() {
        let source = include_str!("commands.rs");
        let registration = source
            .split("pub fn register_filter_window_session")
            .nth(1)
            .and_then(|tail| tail.split("pub fn search_rules").next())
            .expect("filter registration command source");
        assert!(!registration.contains(".url()"));
        let legacy_error = ["could not inspect", " the native filter window"].concat();
        assert!(!source.contains(&legacy_error));
    }

    fn proxy(enable: bool, host: &str, port: u16, bypass: &str) -> SystemProxyConfig {
        SystemProxyConfig {
            enable,
            host: host.to_string(),
            port,
            bypass: bypass.to_string(),
            windows_raw: None,
        }
    }

    fn mock_rule(id: &str) -> Rule {
        Rule {
            id: id.to_string(),
            enabled: true,
            fire_limit: None,
            repeat: false,
            matcher: Matcher {
                method: Some("GET".to_string()),
                url: format!("https://example.com/{id}"),
                url_match: MatchKind::Exact,
            },
            action: Action::Respond {
                status: 200,
                headers: Vec::new(),
                body: id.to_string(),
                body_base64: None,
                content_type: Some("text/plain".to_string()),
                content_encoding: None,
            },
        }
    }

    #[test]
    fn older_import_completion_cannot_overwrite_newer_embedded_rules_mailbox() {
        let pending = std::sync::Mutex::new(crate::state::PendingHarRules::default());
        let bundle = serde_json::to_vec(&proxy_core::RulesExport::new(vec![Scenario {
            id: "newer".to_string(),
            name: "Newer".to_string(),
            rules: vec![mock_rule("newer")],
        }]))
        .expect("serialize bundle");

        let preview = stash_embedded_rules(&pending, 2, Some(bundle.clone()))
            .expect("valid embedded rules preview");
        assert_eq!(preview[0].name, "Newer");
        assert!(stash_embedded_rules(&pending, 1, None).is_none());

        let slot = pending.lock().expect("mailbox");
        assert_eq!(slot.import_id, 2);
        assert_eq!(slot.bundle.as_deref(), Some(bundle.as_slice()));
    }

    #[test]
    fn empty_launch_preflight_does_not_supersede_an_active_import() {
        let controller = controller();
        let active = controller.start_capture_import();
        let launch = crate::launch::PendingCapture::new(None);
        let prepared = std::sync::Mutex::new(None);

        assert_eq!(
            prepare_launch_capture_import(&controller, &launch, &prepared)
                .expect("empty preflight"),
            None
        );
        let result = controller.run_capture_import(
            &active,
            br#"{"log":{"entries":[{"request":{"url":"https://active.test/"},"response":{}}]}}"#,
            "har",
            true,
            |_| true,
        );
        assert!(result.is_ok(), "empty reload must not cancel Compare work");
        assert!(prepared.lock().expect("prepared launch").is_none());
    }

    #[test]
    fn capture_progress_sender_is_monotonic_and_keeps_stage_completions() {
        let messages = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = messages.clone();
        let channel = Channel::new(move |body| {
            received
                .lock()
                .expect("messages")
                .push(body.deserialize::<serde_json::Value>()?);
            Ok(())
        });
        let mut sender = CaptureProgressSender::new(7, channel);

        for progress in [
            CaptureImportProgress {
                stage: CaptureImportStage::Reading,
                completed: 50,
                total: Some(100),
                cancelable: true,
            },
            CaptureImportProgress {
                stage: CaptureImportStage::Reading,
                completed: 10,
                total: Some(100),
                cancelable: true,
            },
            CaptureImportProgress {
                stage: CaptureImportStage::Parsing,
                completed: 0,
                total: Some(100),
                cancelable: true,
            },
            CaptureImportProgress {
                stage: CaptureImportStage::Reading,
                completed: 100,
                total: Some(100),
                cancelable: true,
            },
            CaptureImportProgress {
                stage: CaptureImportStage::Parsing,
                completed: 100,
                total: Some(100),
                cancelable: true,
            },
        ] {
            assert!(sender.report(progress));
        }

        let messages = messages.lock().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["stage"], "reading");
        assert_eq!(messages[0]["completed"], 50);
        assert_eq!(messages[1]["stage"], "parsing");
        assert_eq!(messages[1]["completed"], 0);
        assert_eq!(messages[2]["stage"], "parsing");
        assert_eq!(messages[2]["completed"], 100);
    }

    #[tokio::test]
    async fn compare_summary_stream_settles_only_after_frontend_acknowledgement() {
        let acknowledgements: crate::state::CaptureImportBatchAcks = std::sync::Arc::default();
        let messages = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = messages.clone();
        let channel = Channel::new(move |body| {
            received
                .lock()
                .expect("messages")
                .push(body.deserialize::<serde_json::Value>()?);
            Ok(())
        });
        let controller = controller();
        let template = controller
            .append_capture(
                br#"{"log":{"entries":[{"request":{"url":"https://example.test/"},"response":{}}]}}"#,
                "har",
            )
            .expect("capture imports")
            .into_iter()
            .next()
            .expect("one summary");
        let summaries: Vec<_> = (0..201)
            .map(|index| {
                let mut summary = template.clone();
                summary.id = format!("imported-{index}");
                summary.seq = index + 1;
                summary
            })
            .collect();
        reserve_capture_import_delivery(&acknowledgements, 91);

        let delivery = stream_imported_summaries(&acknowledgements, &channel, 91, &summaries);
        tokio::pin!(delivery);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut delivery)
                .await
                .is_err(),
            "delivery must remain pending after send but before frontend consumption"
        );
        {
            let messages = messages.lock().expect("messages");
            assert_eq!(messages.len(), 1, "batch 1 waits for batch 0's ACK");
            assert_eq!(messages[0]["batchIndex"], 0);
            assert_eq!(messages[0]["summaries"].as_array().map(Vec::len), Some(200));
        }

        assert!(!acknowledge_capture_import_batch(&acknowledgements, 91, 1));
        assert!(acknowledge_capture_import_batch(&acknowledgements, 91, 0));
        assert!(
            !acknowledge_capture_import_batch(&acknowledgements, 91, 0),
            "duplicate acknowledgements are rejected"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut delivery)
                .await
                .is_err(),
            "second batch also waits for frontend consumption"
        );
        {
            let messages = messages.lock().expect("messages");
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[1]["batchIndex"], 1);
            assert_eq!(messages[1]["summaries"].as_array().map(Vec::len), Some(1));
        }
        assert!(!acknowledge_capture_import_batch(&acknowledgements, 91, 0));
        assert!(!acknowledge_capture_import_batch(&acknowledgements, 91, 2));
        assert!(acknowledge_capture_import_batch(&acknowledgements, 91, 1));
        delivery.await.expect("acknowledged delivery completes");

        assert!(
            !acknowledgements
                .lock()
                .expect("acknowledgements")
                .contains_key(&91),
            "terminal delivery removes its acknowledgement mailbox"
        );
        let messages = messages.lock().expect("messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["batchIndex"], 0);
        assert_eq!(messages[1]["batchIndex"], 1);
    }

    #[tokio::test]
    async fn compare_summary_ack_timeout_cleans_its_mailbox() {
        let acknowledgements: crate::state::CaptureImportBatchAcks = std::sync::Arc::default();
        let channel = Channel::new(|_| Ok(()));
        let controller = controller();
        let summaries = controller
            .append_capture(
                br#"{"log":{"entries":[{"request":{"url":"https://example.test/"},"response":{}}]}}"#,
                "har",
            )
            .expect("capture imports");
        reserve_capture_import_delivery(&acknowledgements, 94);

        let error = stream_imported_summaries_with_timeout(
            &acknowledgements,
            &channel,
            94,
            &summaries,
            Duration::from_millis(5),
        )
        .await
        .expect_err("missing frontend ACK times out");

        assert!(error.contains("batch 1"));
        assert!(error.contains("5ms"));
        assert!(!acknowledgements
            .lock()
            .expect("acknowledgements")
            .contains_key(&94));
    }

    #[tokio::test]
    async fn disposing_compare_delivery_closes_its_waiter_and_mailbox() {
        let acknowledgements: crate::state::CaptureImportBatchAcks = std::sync::Arc::default();
        let channel = Channel::new(|_| Ok(()));
        let controller = controller();
        let summaries = controller
            .append_capture(
                br#"{"log":{"entries":[{"request":{"url":"https://example.test/"},"response":{}}]}}"#,
                "har",
            )
            .expect("capture imports");
        reserve_capture_import_delivery(&acknowledgements, 92);

        let delivery = stream_imported_summaries(&acknowledgements, &channel, 92, &summaries);
        tokio::pin!(delivery);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut delivery)
                .await
                .is_err()
        );
        assert!(cancel_capture_import_delivery(&acknowledgements, 92));
        let error = delivery
            .await
            .expect_err("disposed delivery fails promptly");

        assert!(error.contains("cancelled"));
        assert!(!acknowledgements
            .lock()
            .expect("acknowledgements")
            .contains_key(&92));
    }

    #[test]
    fn rejected_activation_never_reaches_the_db() {
        let dir = test_dir("activate-order");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();

        let error = activate_scenario(&controller, &store, Some("missing"), tag())
            .expect_err("the engine rejects an unknown scenario id");
        assert!(
            error.contains("scenario not found"),
            "unexpected error: {error}"
        );
        assert_eq!(
            store.load().expect("load").active_scenario_id,
            None,
            "a rejected activation must not be persisted"
        );

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn failed_mock_commit_persists_no_ghost_rules() {
        let dir = test_dir("mock-order");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();

        let batch = MockBatch {
            scenario_id: "missing".to_string(),
            scenario_name: "Ghosts".to_string(),
            create_scenario: false,
            rules: vec![mock_rule("ghost")],
        };
        commit_and_persist_mock_batch(&controller, &store, batch, tag())
            .expect_err("the engine rejects a commit into a missing scenario");
        let persisted = store.load().expect("load");
        assert!(
            persisted.scenarios.iter().all(|s| s.rules.is_empty()),
            "a rejected batch must not leave ghost rules in the DB"
        );

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn failed_mock_persistence_rolls_back_live_rules_and_history() {
        let dir = test_dir("mock-persist-rollback");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();
        {
            let connection =
                rusqlite::Connection::open(dir.join("autoresponder.sqlite3")).expect("open db");
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_rule_insert
                     BEFORE INSERT ON rules
                     BEGIN
                       SELECT RAISE(FAIL, 'forced persistence failure');
                     END;",
                )
                .expect("install failure trigger");
        }

        let batch = MockBatch {
            scenario_id: "mocks".to_string(),
            scenario_name: "My mocks".to_string(),
            create_scenario: true,
            rules: vec![mock_rule("not-kept")],
        };
        let error = commit_and_persist_mock_batch(&controller, &store, batch, tag())
            .expect_err("forced SQLite error rejects the command");
        assert!(error.contains("forced persistence failure"), "{error}");

        let live = controller.get_autoresponder();
        assert!(
            live.scenarios.iter().all(|scenario| scenario.id != "mocks"),
            "the rejected mutation must be rolled back in the live engine"
        );
        assert!(
            controller.undo().is_none(),
            "a rejected mutation must not advance history"
        );
        let persisted = store.load().expect("load");
        assert!(
            persisted
                .scenarios
                .iter()
                .all(|scenario| scenario.id != "mocks"),
            "the SQLite transaction must not leave the newly-created scenario"
        );

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn committed_mock_batch_is_persisted() {
        let dir = test_dir("mock-commit");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();

        let batch = MockBatch {
            scenario_id: "mocks".to_string(),
            scenario_name: "My mocks".to_string(),
            create_scenario: true,
            rules: vec![mock_rule("kept")],
        };
        let result = commit_and_persist_mock_batch(&controller, &store, batch, tag())
            .expect("commit + persist");
        assert_eq!(result.new_rule_ids, vec!["kept".to_string()]);
        let persisted = store.load().expect("load");
        let scenario = persisted
            .scenarios
            .iter()
            .find(|s| s.id == "mocks")
            .expect("the created scenario is persisted");
        assert_eq!(scenario.rules.len(), 1);
        assert_eq!(scenario.rules[0].id, "kept");
        assert_eq!(persisted.active_scenario_id.as_deref(), Some("mocks"));

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn merged_general_rules_import_is_persisted() {
        let dir = test_dir("import-general");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let destination = controller();
        let initial = AutoResponder {
            scenarios: vec![Scenario {
                id: GENERAL_SCENARIO_ID.to_string(),
                name: proxy_core::GENERAL_SCENARIO_NAME.to_string(),
                rules: vec![mock_rule("existing-general")],
            }],
            active_scenario_id: None,
            general_active: true,
        };
        destination.set_autoresponder(initial.clone());
        store.replace(&initial).expect("seed store");

        let source = controller();
        source.set_autoresponder(AutoResponder {
            scenarios: vec![Scenario {
                id: GENERAL_SCENARIO_ID.to_string(),
                name: proxy_core::GENERAL_SCENARIO_NAME.to_string(),
                rules: vec![mock_rule("imported-general")],
            }],
            active_scenario_id: None,
            general_active: true,
        });

        import_rules_and_persist(
            &destination,
            &store,
            &source.export_rules(None),
            false,
            GeneralRulesImportMode::Merge,
            tag(),
        )
        .expect("merge and persist General");

        let live = destination.get_autoresponder();
        let persisted = store.load().expect("reload store");
        assert_eq!(live.general().expect("live General").rules.len(), 2);
        assert_eq!(persisted.general().expect("durable General").rules.len(), 2);
        assert_eq!(persisted, live);
        assert!(destination.undo().is_some(), "the import remains undoable");

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn mocking_into_general_preserves_the_active_scenario_live_and_on_disk() {
        let dir = test_dir("mock-general-active");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();
        let mut initial = AutoResponder {
            scenarios: vec![Scenario {
                id: "active".into(),
                name: "Active".into(),
                rules: Vec::new(),
            }],
            active_scenario_id: Some("active".into()),
            general_active: true,
        };
        initial.ensure_general();
        controller.set_autoresponder(initial.clone());
        store.replace(&initial).expect("seed store");

        let batch = MockBatch {
            scenario_id: GENERAL_SCENARIO_ID.to_string(),
            scenario_name: proxy_core::GENERAL_SCENARIO_NAME.to_string(),
            create_scenario: false,
            rules: vec![mock_rule("general-mock")],
        };
        commit_and_persist_mock_batch(&controller, &store, batch, tag())
            .expect("commit into General");

        let live = controller.get_autoresponder();
        assert_eq!(live.active_scenario_id.as_deref(), Some("active"));
        assert_eq!(live.general().expect("live General").rules.len(), 1);
        let persisted = store.load().expect("reload store");
        assert_eq!(persisted.active_scenario_id.as_deref(), Some("active"));
        assert_eq!(persisted.general().expect("durable General").rules.len(), 1);

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn empty_mock_batch_does_not_create_or_activate_a_scenario() {
        let dir = test_dir("mock-empty");
        let (store, initial) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();
        controller.set_autoresponder(initial);

        let batch = MockBatch {
            scenario_id: "empty".to_string(),
            scenario_name: "My mocks".to_string(),
            create_scenario: true,
            rules: Vec::new(),
        };
        let result = commit_and_persist_mock_batch(&controller, &store, batch, tag())
            .expect("empty batch is accepted as a no-op");
        assert!(result.new_rule_ids.is_empty());
        assert!(controller
            .get_autoresponder()
            .scenarios
            .iter()
            .all(|scenario| scenario.id != "empty"));
        assert!(
            controller.undo().is_none(),
            "a no-op must not enter history"
        );
        let persisted = store.load().expect("reload store");
        assert!(persisted.active_scenario_id.is_none());
        assert!(persisted
            .scenarios
            .iter()
            .all(|scenario| scenario.id != "empty"));

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn dropping_a_rule_onto_itself_does_not_change_durable_order() {
        let dir = test_dir("reorder-self");
        let (store, _) = RuleStore::open(&dir, false).expect("open store");
        let controller = controller();
        let autoresponder = AutoResponder {
            scenarios: vec![Scenario {
                id: "scenario".into(),
                name: "Scenario".into(),
                rules: vec![mock_rule("one"), mock_rule("two"), mock_rule("three")],
            }],
            active_scenario_id: Some("scenario".into()),
            general_active: true,
        };
        controller.set_autoresponder(autoresponder.clone());
        store.replace(&autoresponder).expect("seed store");

        reorder_rule_and_persist(&controller, &store, "scenario", "two", "two", tag())
            .expect("self drop is a no-op");

        let durable = store.load().expect("reload store");
        let ids: Vec<_> = durable
            .scenarios
            .iter()
            .find(|scenario| scenario.id == "scenario")
            .expect("scenario")
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect();
        assert_eq!(ids, vec!["one", "two", "three"]);
        assert!(
            controller.undo().is_none(),
            "a no-op must not create history"
        );

        drop(store);
        std::fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn identifies_only_enabled_loopback_system_proxies_as_germi() {
        assert!(is_germi_system_proxy(
            &proxy(true, "127.0.0.1", 8080, ""),
            8080
        ));
        assert!(is_germi_system_proxy(
            &proxy(true, "localhost", 8080, ""),
            8080
        ));
        assert!(is_germi_system_proxy(
            &proxy(true, "LOCALHOST", 8080, ""),
            8080
        ));
        assert!(is_germi_system_proxy(&proxy(true, "::1", 8080, ""), 8080));
        assert!(is_germi_system_proxy(&proxy(true, "[::1]", 8080, ""), 8080));
        assert!(!is_germi_system_proxy(
            &proxy(false, "127.0.0.1", 8080, ""),
            8080
        ));
        assert!(!is_germi_system_proxy(
            &proxy(true, "proxy.example.com", 8080, ""),
            8080
        ));
        assert!(
            !is_germi_system_proxy(&proxy(true, "127.0.0.1", 8080, ""), 8888),
            "a different loopback port belongs to another proxy"
        );
    }

    #[tokio::test]
    async fn disposing_reserved_compare_delivery_prevents_a_late_waiter() {
        let acknowledgements: crate::state::CaptureImportBatchAcks = std::sync::Arc::default();
        let channel = Channel::new(|_| Ok(()));
        reserve_capture_import_delivery(&acknowledgements, 93);

        assert!(cancel_capture_import_delivery(&acknowledgements, 93));
        let error = stream_imported_summaries(&acknowledgements, &channel, 93, &[])
            .await
            .expect_err("disposed reservation never becomes a waiter");

        assert!(error.contains("cancelled"));
        assert!(!acknowledgements
            .lock()
            .expect("acknowledgements")
            .contains_key(&93));
    }

    #[test]
    fn status_without_ownership_does_not_read_the_os_proxy() {
        let current = read_owned_system_proxy(&SystemProxyOwnership::default(), || {
            panic!("an unowned status probe must not inspect unrelated OS proxy syntax")
        })
        .expect("an unowned proxy is a known inactive state");

        assert!(current.is_none());
    }

    #[test]
    fn repointing_an_owned_system_proxy_preserves_the_original_restore_target() {
        let original = proxy(true, "prior.example", 3128, "localhost");
        let current = proxy(true, "127.0.0.1", 8080, "");
        let mut ownership = SystemProxyOwnership {
            prior: Some(original.clone()),
            active_port: Some(8080),
            pending_port: None,
        };

        assert!(!prepare_system_proxy_takeover(&mut ownership, &current));
        assert_eq!(ownership.prior, Some(original));
        assert_eq!(ownership.active_port, Some(8080));
    }

    #[test]
    fn reacquiring_after_external_replacement_snapshots_the_replacement() {
        let replacement = proxy(true, "127.0.0.1", 8888, "localhost");
        let mut ownership = SystemProxyOwnership {
            prior: Some(proxy(true, "stale.example", 3128, "")),
            active_port: Some(8080),
            pending_port: None,
        };

        assert!(prepare_system_proxy_takeover(&mut ownership, &replacement));
        assert_eq!(ownership.prior, Some(replacement));
        assert_eq!(ownership.active_port, None);
        assert_eq!(ownership.pending_port, None);
    }

    #[test]
    fn failed_system_proxy_restore_keeps_the_saved_value_for_retry() {
        let saved = proxy(true, "prior.example", 3128, "");
        let current = proxy(true, "127.0.0.1", 8080, "");
        let mut ownership = SystemProxyOwnership {
            prior: Some(saved.clone()),
            active_port: Some(8080),
            pending_port: None,
        };
        let error = restore_saved_proxy(&mut ownership, &current, |_| {
            Err("OS rejected update".into())
        })
        .expect_err("restore fails");
        assert_eq!(error, "OS rejected update");
        assert_eq!(
            ownership.prior,
            Some(saved),
            "the prior proxy must remain available for retry"
        );
        assert_eq!(ownership.active_port, Some(8080));

        assert!(restore_saved_proxy(&mut ownership, &current, |_| Ok(())).expect("retry succeeds"));
        assert!(
            ownership.prior.is_none()
                && ownership.active_port.is_none()
                && ownership.pending_port.is_none(),
            "only a successful restore consumes the saved value"
        );
    }

    #[test]
    fn restore_does_not_clobber_a_different_loopback_proxy() {
        let mut ownership = SystemProxyOwnership {
            prior: Some(SystemProxyConfig::default()),
            active_port: Some(8080),
            pending_port: None,
        };
        let replacement = proxy(true, "127.0.0.1", 8888, "");
        let mut applied = false;

        assert!(!restore_saved_proxy(&mut ownership, &replacement, |_| {
            applied = true;
            Ok(())
        })
        .expect("external replacement is not an error"));
        assert!(!applied, "the replacement proxy must be left untouched");
        assert!(ownership.prior.is_none());
        assert!(ownership.active_port.is_none());
        assert!(ownership.pending_port.is_none());
    }

    #[test]
    fn malformed_owned_journal_disables_the_exact_stale_proxy() {
        let current = proxy(true, "127.0.0.1", 8080, "localhost");
        let mut ownership = SystemProxyOwnership {
            prior: None,
            active_port: Some(8080),
            pending_port: None,
        };
        let mut applied = None;

        assert!(restore_saved_proxy(&mut ownership, &current, |saved| {
            applied = Some(saved.clone());
            Ok(())
        })
        .expect("the stale owned endpoint is disabled"));
        assert_eq!(applied, Some(proxy(false, "127.0.0.1", 8080, "localhost")));
        assert_eq!(ownership, SystemProxyOwnership::default());
    }

    #[test]
    fn interrupted_repoint_recognizes_either_side_of_the_os_transition() {
        let saved = proxy(true, "prior.example", 3128, "");

        for current_port in [8080, 8081] {
            let current = proxy(true, "127.0.0.1", current_port, "localhost");
            let mut ownership = SystemProxyOwnership {
                prior: Some(saved.clone()),
                active_port: Some(8080),
                pending_port: Some(8081),
            };
            let mut restored = None;

            assert!(restore_saved_proxy(&mut ownership, &current, |prior| {
                restored = Some(prior.clone());
                Ok(())
            })
            .expect("either crash outcome remains owned"));
            assert_eq!(restored, Some(saved.clone()));
            assert_eq!(ownership, SystemProxyOwnership::default());
        }
    }
}
