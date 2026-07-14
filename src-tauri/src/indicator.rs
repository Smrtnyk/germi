//! Taskbar/dock icon indicator. The running app's own window icon gets a status
//! dot composited in — teal when the system proxy is routed through Germi, red
//! when it isn't — so the taskbar/dock icon shows the state at a glance (no
//! separate tray). The frontend pushes the state on every system-proxy change.

use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// Re-style the main window's icon to reflect the system-proxy state; the
/// taskbar/dock shows the window icon, so this is the "indicator on the app
/// icon". Touching the window icon must happen on the UI thread.
#[tauri::command]
pub fn set_proxy_indicator(app: AppHandle, system_proxy: bool) {
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let (rgba, width, height) = status_icon(&app, system_proxy);
            let _ = window.set_icon(Image::new(&rgba, width, height));
        }
    });
}

/// The app icon with a status dot composited into the corner. Teal = system
/// proxy routed through Germi, red = off.
fn status_icon(app: &AppHandle, on: bool) -> (Vec<u8>, u32, u32) {
    let (mut rgba, width, height) = match app.default_window_icon() {
        Some(img) => (img.rgba().to_vec(), img.width(), img.height()),
        None => (vec![0u8; 32 * 32 * 4], 32, 32),
    };
    let dot = if on {
        [45u8, 212, 191]
    } else {
        [239u8, 68, 68]
    };
    let center_x = f64::from(width) * 0.72;
    let center_y = f64::from(height) * 0.72;
    let radius = f64::from(width.min(height)) * 0.28;
    let ring = radius * 0.2;
    for row in 0..height {
        for col in 0..width {
            let off_x = f64::from(col) + 0.5 - center_x;
            let off_y = f64::from(row) + 0.5 - center_y;
            let dist = off_x.hypot(off_y);
            if dist > radius {
                continue;
            }
            let color = if dist > radius - ring {
                [255, 255, 255]
            } else {
                dot
            };
            let idx = ((row * width + col) * 4) as usize;
            rgba[idx] = color[0];
            rgba[idx + 1] = color[1];
            rgba[idx + 2] = color[2];
            rgba[idx + 3] = 255;
        }
    }
    (rgba, width, height)
}
