// Prevents an additional console window on Windows in release. DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux display compatibility. Many setups — VMs, cloud/remote desktops, and
    // some GPU/Wayland combinations — either crash under GDK-Wayland ("Error 71
    // Protocol error") or render a blank WebView because WebKitGTK's DMABUF/GBM
    // GPU renderer can't allocate buffers ("Failed to create GBM buffer").
    //
    // Default to the X11 backend and the non-DMABUF renderer for broad
    // compatibility, but only when the user hasn't chosen otherwise — set
    // GDK_BACKEND=wayland (or unset these) to opt back into the native path.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    germi_lib::run()
}
