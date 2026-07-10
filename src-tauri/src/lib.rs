//! Germi desktop shell. Thin Tauri wrapper around the `proxy-core` engine.

mod commands;
mod indicator;
mod instance;
mod persist;
mod portal_hotkey;
mod rule_store;
mod state;

use std::sync::Arc;

use proxy_core::ProxyController;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use state::AppState;

/// Whether the process was started in viewer mode (`--viewer`) — a proxy-less
/// inspector instance that can run alongside the capturing one. Kept as a free
/// function over an iterator so the flag parsing is unit-testable without a
/// running Tauri app.
fn viewer_mode_from_args(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == "--viewer")
}

/// Build the shared [`AppState`] (CA, rule store, persisted settings) and stash
/// it on the app. Split out of the builder chain in `run` so the latter stays a
/// readable wiring list.
fn init_app_state(app: &mut tauri::App, viewer: bool) -> Result<(), Box<dyn std::error::Error>> {
    // Global hotkeys are registered/handled from the webview (see
    // `useGlobalHotkey`); the shell only needs to initialize the plugin.
    // Desktop-only — the lib keeps a mobile entry point.
    #[cfg(desktop)]
    app.handle()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
    // One persistent CA per install, under the OS app-data dir. Treat an
    // unresolvable app-data dir as fatal rather than writing the root CA
    // private key to a predictable, world-traversable temp path.
    let ca_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    // The single-instance check must precede every touch of the shared
    // app-data stores (CA files, autoresponder.sqlite3, settings.json,
    // scripts.json) so a losing instance can never corrupt the primary's
    // state.
    match instance::guard(viewer, &ca_dir) {
        // Deliberately leaked: the lock must live for the whole process
        // lifetime, and the OS releases it when the process exits or dies.
        instance::GuardOutcome::Held(lock) => std::mem::forget(lock),
        instance::GuardOutcome::Skipped => {}
        instance::GuardOutcome::AlreadyRunning => {
            eprintln!("Germi is already running.");
            app.dialog()
                .message("Germi is already running.")
                .title("Germi")
                .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                .blocking_show();
            std::process::exit(1);
        }
        instance::GuardOutcome::Unavailable(e) => {
            tracing::warn!("single-instance lock unavailable, continuing unguarded: {e}");
        }
    }
    let ca = ProxyController::load_or_generate_ca(&ca_dir)
        .map_err(|e| format!("failed to initialize CA: {e}"))?;
    let controller = Arc::new(ProxyController::new(ca));
    let (rule_store, autoresponder) = rule_store::RuleStore::open(&ca_dir, viewer)
        .map_err(|e| format!("failed to initialize autoresponder database: {e}"))?;
    controller.set_autoresponder(autoresponder);
    // Restore persisted proxy settings (host exclusions).
    if let Some(settings) = persist::load_settings(&ca_dir) {
        controller.set_settings(settings);
    }
    // Restore persisted user scripts (request/response hooks).
    if let Some(scripts) = persist::load_scripts(&ca_dir) {
        controller.set_scripts(scripts);
    }
    app.manage(AppState {
        controller,
        rule_store: Arc::new(rule_store),
        ca_dir,
        flow_forwarder: std::sync::Mutex::new(None),
        prior_system_proxy: std::sync::Mutex::new(None),
        compare_seed: std::sync::Mutex::new(None),
        pending_settings_import: std::sync::Mutex::new(None),
        portal_hotkey: portal_hotkey::PortalHotkey::default(),
        viewer,
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let viewer = viewer_mode_from_args(std::env::args());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| init_app_state(app, viewer))
        // Closing the main window quits Germi; secondary windows (compare,
        // detached rule editors) must not keep the process alive (issue #89).
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::proxy_status,
            commands::bound_addr,
            commands::is_viewer_mode,
            commands::launch_viewer,
            commands::start_proxy,
            commands::restart_proxy,
            commands::stop_proxy,
            commands::subscribe_flows,
            commands::list_flows,
            commands::get_flow,
            commands::clear_flows,
            commands::remove_flows,
            commands::remove_captured_flows,
            commands::set_flow_comment,
            commands::get_autoresponder_summary,
            commands::get_rule,
            commands::set_active_scenario,
            commands::set_general_active,
            commands::create_scenario,
            commands::rename_scenario,
            commands::delete_scenario,
            commands::create_rule,
            commands::update_rule,
            commands::delete_rule,
            commands::delete_rules,
            commands::duplicate_rule,
            commands::reorder_rule,
            commands::reset_rule_state,
            commands::rule_hits,
            commands::get_settings,
            commands::set_settings,
            commands::get_scripts,
            commands::set_scripts,
            commands::check_script,
            commands::get_settings_sections,
            commands::export_settings,
            commands::peek_settings_import,
            commands::apply_settings_import,
            commands::test_scenario,
            commands::mock_flows,
            commands::check_doc_availability,
            commands::ca_info,
            commands::export_ca,
            commands::regenerate_ca,
            commands::set_system_proxy,
            commands::clear_system_proxy,
            commands::pick_file,
            commands::file_exists,
            commands::search_bodies,
            commands::search_headers,
            commands::search_rules,
            commands::save_session,
            commands::open_capture,
            commands::append_capture,
            commands::open_dropped_capture,
            commands::append_dropped_capture,
            commands::compare_flow_bodies,
            commands::set_compare_seed,
            commands::get_compare_seed,
            commands::export_rules,
            commands::import_rules,
            commands::history_undo,
            commands::history_redo,
            indicator::set_proxy_indicator,
            portal_hotkey::global_shortcut_mode,
            portal_hotkey::apply_portal_hotkey,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Germi")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Err(e) = commands::restore_prior_system_proxy(state.inner()) {
                        tracing::warn!("failed to restore system proxy on exit: {e}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::viewer_mode_from_args;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn viewer_flag_detected_anywhere_in_args() {
        assert!(viewer_mode_from_args(args(&["germi", "--viewer"])));
        assert!(viewer_mode_from_args(args(&["germi", "--viewer", "extra"])));
    }

    #[test]
    fn absent_viewer_flag_is_normal_mode() {
        assert!(!viewer_mode_from_args(args(&["germi"])));
        assert!(!viewer_mode_from_args(args(&["germi", "--view", "viewer"])));
    }
}
