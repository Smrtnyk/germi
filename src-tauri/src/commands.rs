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
    HistoryTag, MockBatch, MockResult, ProxyController, ProxySettings, Rule, RuleSearchScope,
    RuleSummary, Scenario, ScenarioSummary, Script, ScriptDiagnostic, SearchSide, TestInput,
    TestResult, GENERAL_SCENARIO_ID,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::broadcast::error::RecvError;

use crate::state::{AppState, SystemProxyOwnership};
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

/// Peek an opened capture for an embedded `_germiRules` bundle and park it for
/// `apply_har_rules`. A file without a usable bundle CLEARS the mailbox, so a
/// stale offer can never apply rules from an earlier file.
fn stash_embedded_rules(
    state: &State<'_, AppState>,
    bytes: &[u8],
    ext: &str,
) -> Option<Vec<proxy_core::ScenarioPreview>> {
    let bundle = if ext == "har" {
        proxy_core::har_embedded_rules(bytes)
    } else {
        None
    };
    let preview = bundle.as_deref().and_then(proxy_core::preview_rules);
    if let Ok(mut slot) = state.pending_har_rules.lock() {
        *slot = if preview.is_some() { bundle } else { None };
    }
    preview
}

/// Show the capture-file picker (.har / .saz) and read the chosen file.
/// Returns the bytes + lowercased extension, or `None` if cancelled.
fn pick_capture_file(app: &tauri::AppHandle) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Captures (.har, .saz)", &["har", "saz"])
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

/// Open a capture file — a HAR or a Fiddler SAZ archive —
/// REPLACING the current traffic. Dispatches on the file extension. Returns the
/// number of flows loaded, or `None` if the user cancels the picker.
#[tauri::command]
pub async fn open_capture(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OpenedCapture>, String> {
    let Some((bytes, ext)) = pick_capture_file(&app)? else {
        return Ok(None);
    };
    let count = state
        .controller
        .open_capture(&bytes, &ext)
        .map_err(|e| e.to_string())?;
    Ok(Some(OpenedCapture {
        count,
        embedded_rules: stash_embedded_rules(&state, &bytes, &ext),
    }))
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
/// An HTML5 file drop hands the frontend the File's *bytes* (base64 over IPC),
/// not a filesystem path like the native picker — so there is nothing to
/// `std::fs::read` here. `ext` (the dropped file's extension) tells HAR and
/// SAZ apart.
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
) -> Result<OpenedCapture, String> {
    let (bytes, ext) = decode_dropped_capture(&data_b64, &ext)?;
    let count = state
        .controller
        .open_capture(&bytes, &ext)
        .map_err(|e| e.to_string())?;
    Ok(OpenedCapture {
        count,
        embedded_rules: stash_embedded_rules(&state, &bytes, &ext),
    })
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

/// Import autoresponder scenarios from a rules file — a HAR carrying
/// `_germiRules`, or a legacy `.germi-rules` bundle from before the formats
/// were unified. `replace == false` merges (appends); `replace == true` wipes
/// the existing scenarios first. Persists the merged config and returns the
/// number of scenarios imported (0 if the user cancels).
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
        .add_filter("Mock rules (.har, .germi-rules)", &["har", "germi-rules"])
        .blocking_pick_file()
    else {
        return Ok(0);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    controller.with_history(history_tag, |c| {
        let count = c.import_rules(&bytes, replace).map_err(|e| e.to_string())?;
        state
            .rule_store
            .replace(&c.get_autoresponder())
            .map_err(|e| format!("imported rules could not be persisted: {e}"))?;
        Ok(count)
    })
}

/// Import the mock-rules bundle embedded in the last opened HAR (parked by
/// `stash_embedded_rules` after the user accepted the offer). Always appends —
/// imported scenarios arrive re-keyed under deduped names, never replacing or
/// activating anything. Returns the number of scenarios imported.
#[tauri::command]
pub async fn apply_har_rules(
    state: State<'_, AppState>,
    history_tag: HistoryTag,
) -> Result<usize, String> {
    let controller = state.controller.clone();
    let mut pending = state
        .pending_har_rules
        .lock()
        .map_err(|_| "Pending mock rules lock is poisoned".to_string())?;
    let count = {
        let bytes = pending
            .as_deref()
            .ok_or_else(|| "No pending mock rules to import".to_string())?;
        controller.with_history(history_tag, |c| {
            let count = c.import_rules(bytes, false).map_err(|e| e.to_string())?;
            state.rule_store.replace(&c.get_autoresponder())?;
            Ok::<usize, String>(count)
        })?
    };
    // Consume the parked bundle only after both the live import and SQLite
    // transaction succeed, so a persistence error remains retryable.
    pending.take();
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
