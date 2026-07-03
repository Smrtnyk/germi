---
name: verify
description: Drive the real Germi app headlessly (WebDriver into the live Tauri webview) to verify a change end-to-end — real IPC, real backend, real settings.json, real multi-window events. Use when a change needs runtime observation beyond unit/browser tests.
---

# Verifying Germi by driving the real app (headless)

The real app — Rust backend, Tauri IPC, WebKitGTK webview, OS windows — can be
driven headlessly on this machine with no extra installs: **WebKitWebDriver**
(ships with webkit2gtk) attaches to the app's webview when the app runs with
`TAURI_WEBVIEW_AUTOMATION=true`, under a **headless mutter** compositor.

## Recipe

1. **Build**: `pnpm build` (dist), `cargo build -p germi` (binary). A **debug**
   binary loads `devUrl` (http://localhost:1420), NOT the embedded dist — so
   also start `pnpm dev` in the background and navigate the session to
   `http://localhost:1420/` after connecting. IPC works fine from the dev URL.

2. **Session** (one background script):

   ```bash
   RT=/tmp/g93rt && rm -rf $RT && mkdir -p $RT && chmod 700 $RT
   export XDG_RUNTIME_DIR=$RT            # SHORT path — wayland socket dies >108 bytes
   export XDG_DATA_HOME=<sandbox>/data   # keeps the REAL ~/.local/share Germi data safe
   export XDG_CONFIG_HOME=<sandbox>/config XDG_CACHE_HOME=<sandbox>/cache
   export GDK_BACKEND=wayland            # main.rs forces x11 only-if-unset; headless mutter is wayland-only
   export TAURI_WEBVIEW_AUTOMATION=true
   dbus-run-session -- bash -c '
     mutter --headless --no-x11 --wayland-display=wayland-93 --virtual-monitor 1280x800 &
     sleep 2; export WAYLAND_DISPLAY=wayland-93
     exec WebKitWebDriver --port=4444 --host=127.0.0.1'
   ```

3. **Connect** (raw W3C WebDriver over curl, no client lib needed):

   ```bash
   curl -s -X POST http://127.0.0.1:4444/session -H 'Content-Type: application/json' \
     -d '{"capabilities":{"alwaysMatch":{"webkitgtk:browserOptions":{"binary":"<abs>/target/debug/germi"}}}}'
   ```

   The session starts on `about:blank`; `POST /session/<id>/url` to
   `http://localhost:1420/` loads the app. `GET /window/handles` lists every
   app window (compare window, rule windows) — `POST /window {handle}` switches;
   `GET /screenshot` returns base64 PNG of the current window.

4. **Drive via `execute/sync`** — element click / W3C actions return
   `unsupported operation` (wry's automation exposes scripting + navigation,
   not input synthesis), so dispatch events from JS. Everything downstream
   (React handlers → IPC → backend → persistence → cross-window events) is real.
   - Buttons: find by text and `.click()`.
   - Row clicks: `row.dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:...}))`.
   - Controlled inputs: set value via the **native setter**
     (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)`),
     dispatch `input`, wait a tick (separate execute call), dispatch `change` —
     assigning `el.value` directly gets deduped by React's value tracker.

5. **Assert at real boundaries**: computed styles / DOM state via execute;
   `settings.json` under `$XDG_DATA_HOME/dev.germi.app/`; proxy behavior with
   `curl -x http://127.0.0.1:8080 …` (flows appear live; a
   `python3 -m http.server` makes a fine origin). Relaunch = DELETE the session,
   POST a new one (fresh boot against whatever the sandbox dir now holds).

## Gotchas

- Data rows are `.flow-canvas .flow-row` — the header row also carries
  `.flow-row`.
- Kill leftovers before re-running: `pkill -f 'WebKitWebDriver --port=4444'`,
  `pkill -f 'wayland-display=wayland-93'` — a stale driver holds port 4444 and
  the new one dies with "Unable to listen".
- The GTK color picker (and any native dialog) cannot be driven — set the
  `<input type="color">` value via JS instead; file dialogs are off-limits, so
  probe import/export by editing the sandbox files + relaunching.
- `DELETE /session` closes the app. Also kill mutter, vite, and any helper
  http server when done.
