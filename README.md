# Germi

A scriptable HTTP/S debugging proxy — like Fiddler/Charles, but your own. Capture
traffic, inspect it, and **auto-respond with your own sprinkles**: mock responses,
map local files, rewrite headers/bodies, block or redirect. **Rust + Tauri**, on
**Windows and Linux**.

> Status: usable and feature-rich — capture/inspect, scenario-based mocking with a
> rule tester, HAR/SAZ import, filtering + body search, configurable columns, a
> settings panel, and lossless `.germi` sessions.

## Architecture

The proxy **engine** lives in `crates/proxy-core` — pure Rust, zero GUI coupling,
fully unit-tested, and runnable on its own (`cargo run -p proxy-core --example
standalone`). `src-tauri` is a thin Tauri v2 shell (IPC commands + event
streaming), and `src/` is the React + Vite UI.

[`hudsucker`](https://crates.io/crates/hudsucker) (hyper + rustls + rcgen) runs as
a long-lived `tokio` task in the Tauri process. Captured flows stream to the UI as
**batched, lightweight summaries** (~60 ms / 200 events); full headers/bodies stay
in Rust and load on demand — the IPC bridge is the bottleneck, not the proxy.

## Quick start

Needs **Rust** (stable), **Node 22+**, **pnpm 10+**, and a C toolchain + CMake (for
`aws-lc-rs`). Linux also needs the WebKitGTK/GTK dev libraries:

```sh
# Fedora
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel \
  openssl-devel gcc gcc-c++ cmake perl file nss-tools
# Debian/Ubuntu
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  librsvg2-dev libappindicator3-dev patchelf build-essential cmake file libnss3-tools
```

Windows: the WebView2 runtime (preinstalled on Win 10/11) + NASM for `aws-lc-rs`.

```sh
pnpm install
pnpm tauri dev                               # desktop app, hot reload
pnpm tauri build                             # installers (.msi/.exe, .deb/.rpm/.AppImage)
cargo test -p proxy-core                     # test the engine
cargo run -p proxy-core --example standalone # run the proxy headless
```

**Linux VMs / remote desktops:** Germi forces the X11 backend + non-DMABUF renderer
(avoids `Error 71` crashes and blank `GBM buffer` windows). Opt back into Wayland/GPU
with `GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=0 pnpm tauri dev`.

## Trust the CA

HTTPS interception needs Germi's root CA trusted once — open the **CA certificate**
dialog for the per-OS steps (export/regenerate live under **Settings → Certificates**).
On Linux, browsers keep their own NSS store, so the dialog includes a `certutil` step.

Then flip **System proxy: ON** (sets the OS proxy) or point a specific app at
`127.0.0.1:8080`, and traffic streams into the list.

## Features

- **Capture & inspect** — virtualized traffic list; content-aware inspector with
  decoded gzip/br/deflate bodies, pretty/raw, hex view, and image preview.
- **Auto-responder** — rules grouped into switchable **scenarios** (one active, or
  Off). Each rule is `matcher → action`: auto-respond, map-local-file, block, set
  request/response header, set status, or regex-rewrite the body. Built-in **offline
  tester**, lazy-loaded rule details, and SQLite-backed persistence.
- **Import & bulk-mock** — load **HAR** or Fiddler **SAZ** archives via **Open**; multi-select
  rows (Shift-range, Ctrl/⌘-click, **Ctrl/⌘ A** to select all) → **Add to scenario**
  to seed mock rules from real responses, or **⚡ Mock this** on one. Selecting
  several shows a summary (counts, hosts, sizes) in the Inspector. Prune noise with
  **Delete** (or right-click → Delete) to save a cleaned-up session.
- **Replay-friendly** — imported flows are marked with a violet bar (and an optional
  **Origin** column) so they stand out from live captures. While replaying through the
  auto-responder, captured traffic piles up — one **Delete captured** click prunes it
  and keeps only the imported reference (undoable). Filter with `is:imported` / `is:captured`.
- **Filtering** — highlights matches in place (Fiddler-style) with an `N of M` count:
  type/status chips, a token filter (`host: status:4xx kind:xhr is:imported -neg /regex/` —
  see the `?` popover), and backend `body:` / `req-body:` / `resp-body:` content search.
- **Columns** — configurable in **Settings → Columns** (show/hide, reorder, presets,
  drag-resize): a leading **request number (`#`)** to re-sort back to capture order and
  reference a request, scheme, sizes, **timing (TTFB / Time / Download)**, **Mocked-by**, an
  editable **Comment**, and **pin-any-header** columns.
- **Settings** — Connections (port, **allow remote devices**), Certificates
  (export/regenerate), Interception (host exclusions, tunneled), Capture (max flows,
  record-only filter, capture-on-start), Throttling (response delay). Import/export
  as JSON.
- **Sessions** — traffic is **not** auto-persisted (privacy). **Save** a lossless
  `.germi` file; one **Open** loads any supported capture — `.germi`, HAR, or SAZ —
  replacing the current traffic (it confirms first when traffic is present).
- **Viewer mode** — **New viewer** (or launching with `--viewer`) opens a second,
  proxy-less window for inspecting saved `.germi`/HAR/SAZ captures *alongside* a
  capturing instance, without the two fighting over the proxy port or system proxy.
  The proxy controls and the (proxy-dependent) autoresponder are hidden and a
  **Viewer mode** badge makes the state obvious.

## Limitations

Inherent to intercepting proxies, not bugs:

- **Certificate pinning** (banking/native/mobile apps) rejects even a trusted CA.
- **HTTP/3 / QUIC** (UDP 443) escapes a TCP proxy; block UDP 443 to force a TCP
  fallback Germi intercepts as HTTP/1.1 (HTTP/2 is intentionally off).
- **Proxy-unaware apps** (many Go/Rust/Flutter) ignore the system proxy.
- **Linux browsers** keep their own NSS trust store — see the CA dialog's `certutil`.

## Roadmap

HTTP/2 interception · WebSocket frame capture/edit · breakpoints · repeater ·
upstream/parent-proxy chaining · SQLite-backed persistent store.

## License

[0BSD](LICENSE) (BSD Zero Clause License) — a maximally permissive,
OSI-approved license: use, copy, modify and distribute freely, with no
attribution requirement.
