//! Germi desktop shell. Thin Tauri wrapper around the `proxy-core` engine.

mod commands;
mod indicator;
mod persist;
mod portal_hotkey;
mod rule_store;
mod state;

use std::sync::Arc;

use proxy_core::ProxyController;
use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
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
            let ca = ProxyController::load_or_generate_ca(&ca_dir)
                .map_err(|e| format!("failed to initialize CA: {e}"))?;
            let controller = Arc::new(ProxyController::new(ca));
            let (rule_store, autoresponder) = rule_store::RuleStore::open(&ca_dir)
                .map_err(|e| format!("failed to initialize autoresponder database: {e}"))?;
            controller.set_autoresponder(autoresponder);
            // Restore persisted proxy settings (host exclusions).
            if let Some(settings) = persist::load_settings(&ca_dir) {
                controller.set_settings(settings);
            }
            app.manage(AppState {
                controller,
                rule_store: Arc::new(rule_store),
                ca_dir,
                flow_forwarder: std::sync::Mutex::new(None),
                prior_system_proxy: std::sync::Mutex::new(None),
                portal_hotkey: portal_hotkey::PortalHotkey::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::proxy_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::subscribe_flows,
            commands::list_flows,
            commands::get_flow,
            commands::clear_flows,
            commands::remove_flows,
            commands::set_flow_comment,
            commands::get_autoresponder_summary,
            commands::get_rule,
            commands::set_active_scenario,
            commands::create_scenario,
            commands::rename_scenario,
            commands::delete_scenario,
            commands::create_rule,
            commands::update_rule,
            commands::delete_rule,
            commands::duplicate_rule,
            commands::reorder_rule,
            commands::reset_rule_state,
            commands::rule_hits,
            commands::get_settings,
            commands::set_settings,
            commands::export_settings,
            commands::import_settings,
            commands::test_scenario,
            commands::mock_flows,
            commands::ca_info,
            commands::export_ca,
            commands::regenerate_ca,
            commands::set_system_proxy,
            commands::clear_system_proxy,
            commands::import_archive,
            commands::pick_file,
            commands::file_exists,
            commands::search_bodies,
            commands::save_session,
            commands::open_session,
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
