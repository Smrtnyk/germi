//! Germi desktop shell. Thin Tauri wrapper around the `proxy-core` engine.

mod commands;
mod persist;
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
        .setup(|app| {
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
            // Restore persisted scenarios (else the seeded example remains).
            if let Some(ar) = persist::load_autoresponder(&ca_dir) {
                controller.set_autoresponder(ar);
            }
            // Restore persisted proxy settings (host exclusions).
            if let Some(settings) = persist::load_settings(&ca_dir) {
                controller.set_settings(settings);
            }
            app.manage(AppState {
                controller,
                ca_dir,
                flow_forwarder: std::sync::Mutex::new(None),
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
            commands::set_flow_comment,
            commands::get_autoresponder,
            commands::set_autoresponder,
            commands::reset_rule_state,
            commands::rule_hits,
            commands::get_settings,
            commands::set_settings,
            commands::export_settings,
            commands::import_settings,
            commands::test_rules,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Germi");
}
