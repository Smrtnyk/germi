//! Taskbar/dock icon indicator. The running app's own window icon gets a status
//! dot composited in while the system proxy is routed through Germi. When it is
//! off the ordinary app icon is restored, so the taskbar/dock does not show a
//! misleading zero/error badge. The frontend pushes the state on every
//! system-proxy change.

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

/// The app icon with a teal status dot composited into the corner while the
/// system proxy is routed through Germi. Off restores the unmodified app icon.
fn status_icon(app: &AppHandle, on: bool) -> (Vec<u8>, u32, u32) {
    let (rgba, width, height) = match app.default_window_icon() {
        Some(img) => (img.rgba().to_vec(), img.width(), img.height()),
        None => (vec![0u8; 32 * 32 * 4], 32, 32),
    };
    status_icon_pixels(rgba, width, height, on)
}

fn status_icon_pixels(mut rgba: Vec<u8>, width: u32, height: u32, on: bool) -> (Vec<u8>, u32, u32) {
    if !on {
        return (rgba, width, height);
    }
    let dot = [45u8, 212, 191];
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_proxy_uses_the_unmodified_app_icon() {
        let original = vec![17u8; 8 * 8 * 4];
        let (actual, width, height) = status_icon_pixels(original.clone(), 8, 8, false);

        assert_eq!(actual, original);
        assert_eq!((width, height), (8, 8));
    }

    #[test]
    fn enabled_proxy_adds_the_teal_badge_without_recoloring_the_opposite_corner() {
        let original = vec![17u8; 16 * 16 * 4];
        let (actual, _, _) = status_icon_pixels(original.clone(), 16, 16, true);

        assert_ne!(actual, original);
        assert_eq!(&actual[..4], &original[..4]);
        assert!(actual
            .chunks_exact(4)
            .any(|pixel| pixel == [45, 212, 191, 255]));
    }
}
