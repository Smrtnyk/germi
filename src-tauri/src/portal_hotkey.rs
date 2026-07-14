//! Wayland global shortcuts via the XDG `GlobalShortcuts` portal.
//!
//! The X11 key grabs that `tauri-plugin-global-shortcut` uses don't fire on
//! Wayland, so on a Wayland session we register an abstract "toggle-system-proxy"
//! shortcut through the portal instead. The compositor (GNOME/KDE) owns the
//! actual key binding — the recorded accelerator is only a *preferred* trigger;
//! the user confirms/rebinds it in the system dialog or desktop keyboard
//! settings. When the shortcut fires we emit `hotkey-fired` to the webview,
//! which runs the same toggle as the toolbar. Non-Wayland platforms keep using
//! the plugin (see the frontend's `global_shortcut_mode` branch).

use tauri::{AppHandle, State};

use crate::state::AppState;

#[cfg(target_os = "linux")]
const SHORTCUT_ID: &str = "toggle-system-proxy";

/// Holds the live portal listener task so a rebind can cancel the previous one.
#[derive(Default)]
pub struct PortalHotkey {
    #[cfg(target_os = "linux")]
    task: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl PortalHotkey {
    #[cfg(target_os = "linux")]
    fn apply(&self, app: &AppHandle, accel: Option<String>) {
        let Ok(mut guard) = self.task.lock() else {
            return;
        };
        if let Some(prev) = guard.take() {
            prev.abort();
        }
        let Some(accel) = accel else {
            return;
        };
        let app = app.clone();
        let trigger = accel_to_portal_trigger(&accel);
        *guard = Some(tauri::async_runtime::spawn(async move {
            if let Err(e) = run(app.clone(), trigger).await {
                use tauri::Emitter;
                tracing::warn!("global shortcuts portal error: {e}");
                let _ = app.emit(
                    "hotkey-error",
                    "The desktop refused the global shortcut. On Wayland this needs an installed \
                     build with a valid app id — it won't bind when launched from a dev/IDE shell.",
                );
            }
        }));
    }

    #[cfg(not(target_os = "linux"))]
    fn apply(&self, _app: &AppHandle, _accel: Option<String>) {}
}

#[cfg(target_os = "linux")]
async fn run(app: AppHandle, trigger: String) -> ashpd::Result<()> {
    use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
    use ashpd::desktop::CreateSessionOptions;
    use futures_util::StreamExt;
    use tauri::Emitter;

    let shortcuts = GlobalShortcuts::new().await?;
    let session = shortcuts
        .create_session(CreateSessionOptions::default())
        .await?;
    let shortcut =
        NewShortcut::new(SHORTCUT_ID, "Toggle the system proxy").preferred_trigger(Some(&*trigger));
    // Blocks until the compositor (and user, if it prompts) accepts the binding.
    shortcuts
        .bind_shortcuts(&session, &[shortcut], None, BindShortcutsOptions::default())
        .await?
        .response()?;
    tracing::info!("system-proxy shortcut bound via GlobalShortcuts portal (hint: {trigger})");

    let mut activated = shortcuts.receive_activated().await?;
    while let Some(event) = activated.next().await {
        if event.shortcut_id() == SHORTCUT_ID {
            let _ = app.emit("hotkey-fired", ());
        }
    }
    let _ = session.close().await;
    Ok(())
}

/// Translate a Tauri accelerator (`CmdOrCtrl+Shift+P`) to the portal's preferred
/// trigger format (`CTRL+SHIFT+p`). Best-effort: GNOME often lets the user pick
/// the real key regardless, so this is only a hint.
#[cfg(target_os = "linux")]
fn accel_to_portal_trigger(accel: &str) -> String {
    accel
        .split('+')
        .map(|part| match part {
            "CmdOrCtrl" | "Ctrl" | "Control" => "CTRL".to_string(),
            "Super" | "Meta" | "Cmd" | "Command" => "SUPER".to_string(),
            "Alt" | "Option" => "ALT".to_string(),
            "Shift" => "SHIFT".to_string(),
            key if key.len() == 1 => key.to_ascii_lowercase(),
            key => key.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Which global-shortcut backend the frontend should drive: the portal on a
/// Wayland session (where X11 grabs don't fire), the plugin everywhere else.
#[tauri::command]
pub fn global_shortcut_mode() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        let wayland =
            std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"));
        if wayland {
            "portal"
        } else {
            "plugin"
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "plugin"
    }
}

/// (Re)bind the system-proxy shortcut through the portal; an empty accelerator
/// unbinds it. No-op off Linux.
#[tauri::command]
pub fn apply_portal_hotkey(app: AppHandle, state: State<'_, AppState>, accel: String) {
    let accel = if accel.trim().is_empty() {
        None
    } else {
        Some(accel)
    };
    state.portal_hotkey.apply(&app, accel);
}
