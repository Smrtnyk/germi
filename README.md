# Germi

A custom, scriptable HTTP/S debugging proxy — like Fiddler/Charles, but tailored
to your own needs. Capture traffic, inspect it, and **auto-respond with your own
sprinkles**: mock responses, map local files, rewrite headers and bodies, block
or redirect requests. Built with **Rust + Tauri**, cross-platform on **Windows
and Linux**.

> Status: **foundation / MVP scaffold.** The proxy engine, capture pipeline,
> inspector and rules/auto-respond engine work. See [Roadmap](#roadmap) for
> what's next.

## Architecture

Germi is split into two crates plus a React UI, so the engine has zero GUI
coupling and can be built, tested and run on its own.

```
germi/
├── crates/proxy-core/     # The proxy engine. NO GUI deps — pure Rust.
│   ├── src/ca.rs          #   root CA generation/persistence (rcgen)
│   ├── src/handler.rs     #   hudsucker handler: capture + apply rules
│   ├── src/rules.rs       #   the auto-respond / mocking rules engine
│   ├── src/store.rs       #   bounded in-memory flow store
│   ├── src/flow.rs        #   captured-data model + IPC DTOs
│   └── examples/standalone.rs   # run the proxy WITHOUT the desktop shell
├── src-tauri/             # Thin Tauri v2 shell: commands + event streaming
│   └── src/commands.rs    #   start/stop, flows, autoresponder (scenarios), CA, sysproxy
├── src/                   # React + Vite frontend
│   └── components/        #   Toolbar, TrafficList (virtualized), Inspector, Rules, CaDialog
└── .github/workflows/     # Cross-platform CI (native Win + Linux runners)
```

**Engine.** [`hudsucker`](https://crates.io/crates/hudsucker) (hyper + rustls +
rcgen) runs as a long-lived `tokio` task inside the Tauri process. Each request/
response is captured, run through the rules engine, and streamed to the UI.

**Streaming.** Captured flows reach the webview over Tauri's **Channel API** in
**batches** (~60 ms or 200 events) — only lightweight summaries (method, host,
path, status, size, timing). Full headers/bodies stay in Rust and are fetched on
demand when you click a row. The IPC bridge, not the proxy, is the bottleneck, so
this keeps the UI smooth under a firehose.

**TLS interception.** On first run Germi generates a root CA (persisted under the
app data dir) and mints a short-lived per-host leaf cert for each intercepted
domain. You install/trust the CA once (see the in-app **CA certificate** dialog).

## Prerequisites

- **Rust** (stable) and **Node 20+** with **pnpm 10+**.
- A C toolchain + CMake (to build `aws-lc-rs`, rustls's crypto backend).
- **Linux only:** the WebKitGTK + GTK dev libraries Tauri needs for its webview.

### Linux system dependencies

**Fedora** (this repo's dev box):

```sh
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
  librsvg2-devel openssl-devel gcc gcc-c++ cmake perl file
# For trusting the CA in Chrome/Firefox:
sudo dnf install nss-tools
```

**Debian/Ubuntu:**

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  librsvg2-dev libappindicator3-dev patchelf build-essential cmake file
sudo apt-get install libnss3-tools   # CA trust for browsers
```

Windows needs the WebView2 runtime (preinstalled on Windows 10/11; the installer
bundles it otherwise) and NASM when building `aws-lc-rs` from source.

## Running

```sh
pnpm install
pnpm tauri dev        # launches the desktop app with hot reload
```

To build distributable installers (`.msi`/`.exe` on Windows; `.deb`/`.AppImage`/
`.rpm` on Linux):

```sh
pnpm tauri build
```

### Run the engine without the GUI

The proxy engine is a standalone crate — handy for headless use or hacking on the
pipeline:

```sh
cargo run -p proxy-core --example standalone
# then trust the printed CA, set 127.0.0.1:8080 as your HTTP/HTTPS proxy
```

### Test the engine

```sh
cargo test -p proxy-core
```

### Linux display notes (VMs / remote desktops)

On many Linux setups — VMs, cloud/remote desktops, some NVIDIA/Wayland combos —
GTK either crashes under Wayland (`Error 71 Protocol error`) or the WebView
renders blank (`Failed to create GBM buffer`). Germi defaults to the X11 backend
and the non-DMABUF renderer on Linux to avoid both. To opt back into the native
Wayland/GPU path:

```sh
GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=0 pnpm tauri dev
```

## Using it

1. **Start** the proxy (default `127.0.0.1:8080`).
2. **Trust the CA** — open the **CA certificate** dialog and follow the per-OS
   steps. (One-time. Required for HTTPS.)
3. **Route traffic** — either flip **System proxy: ON** (sets the OS proxy via
   WinINET / GNOME / KDE), or point a specific browser/app at `127.0.0.1:8080`.
4. **Watch** requests stream into the list; click one to inspect headers/body.
5. **Mock** on the **Autoresponder** tab — see scenarios below.

### The autoresponder (scenarios + rules)

Rules live in **scenarios** — named, switchable groups shown as tabs. **Exactly
one scenario is active at a time** (or **Off** for plain passthrough), so you can
keep many mock setups around — "Happy path", "Error states", "Slow 3G" — and flip
between them instantly. Within the active scenario each rule has its own on/off.

A rule is `{ matcher → action }`, evaluated top-to-bottom; the first
short-circuiting action wins. Matchers scope on method + URL (contains / exact /
regex). Actions:

| Action | Phase | Effect |
| --- | --- | --- |
| **Auto-respond** | request | Return a synthesized response (status + headers + body). The core mock. |
| **Map local file** | request | Serve a local file as the response (content-type inferred). |
| **Block** | request | Drop with a 403. |
| **Set request header** | request | Add/replace a header before forwarding. |
| **Set response header** | response | Add/replace a response header. |
| **Set status** | response | Override the response status code. |
| **Rewrite response body** | response | Literal or regex find/replace (with `$1` capture refs). |

A disabled example rule (`Mock GET /api/health`) ships so you can see the shape.

**Test before you enable.** The Rules tab has a built-in tester: type a sample
request (and an optional sample upstream response), hit **Run test**, and see
exactly which rules match, whether one short-circuits, and the precise response a
client would get — no network, no side effects. De-risks regex and ordering.

Scenarios are **persisted** to `autoresponder.json` in the app data dir, so they
survive restarts.

### Importing captures & bulk-mocking

Click **Import** to load a **HAR** (browser DevTools / Charles export) or Fiddler
**SAZ** archive — its sessions land in the traffic list like live captures
(SAZ bodies are de-chunked and decompressed; unencrypted archives only). Then
**Ctrl/Shift-click** to multi-select rows and **Add to scenario** to turn them
all into mock rules at once, each seeded from its real response. Or inspect a
single request and hit **⚡ Mock this →**.

### Filtering the traffic list

Filtering **highlights** matches in place (Fiddler-style) — matching rows stay,
non-matching rows dim, and an `N of M` count shows up top. Nothing is hidden.

- **Type chips** (Fetch/XHR, Doc, JS, CSS, Img, Font, Media, WS, Wasm, Other) and
  **status-class chips** (2xx…5xx, Pending) — click to highlight, multi-select = OR.
  Type is *inferred* (a proxy has no browser initiator), best-effort from
  `Sec-Fetch-Dest`/headers/content-type/extension.
- **A token filter box** (with a `?` syntax popover): bare words substring-match
  the URL, `/regex/` for regex, `-` negates. Tokens: `method: host: path: scheme:
  status:` (supports `status:404`, `status:4xx`, `status:>=400`), `mime: kind: ext:
  rule: larger-than: smaller-than: slower-than:`. All evaluated instantly on the
  in-memory rows.
- **`body:` / `req-body:` / `resp-body:`** search the (decompressed) bodies in the
  backend — the one filter that scans content. Combine freely, e.g.
  `kind:xhr status:5xx body:timeout`.

### Columns

The traffic list's columns are configurable in **Settings → Columns**: show/hide,
reorder (↑/↓), and **presets** (Minimal / Default / Timing / Sizes / Mocking).
Drag the header dividers to resize; double-click a divider to reset.

Beyond the basics (method, host, path, status, type) you can add: **scheme, kind,
request/response/total size, start time, Mocked-by** (which rule fired), an
inline-editable **Comment** (per-flow note — click to edit; saved with sessions),
and **timing** — **TTFB** (time-to-first-byte), **Time** (overall), and
**Download** (Time − TTFB). Timing is honest about its limits: a proxy can't see
the browser's DNS/TCP/TLS phases, so there's no full Fiddler waterfall — just the
request → first-byte → complete split Germi can actually measure.

You can also **pin any header as a column** (e.g. `cf-ray`, `content-encoding`, or
`req:referer` for a request header) — the value is extracted in Rust so it rides
the existing summary stream cheaply.

### Settings

The **⚙ Settings** panel (extensible, with Import/Export of the config as JSON):

- **Connections** — listen port (remembered across launches) and **Allow remote
  devices to connect** (bind `0.0.0.0`) so a phone/another machine can route
  through Germi. Loopback-only by default.
- **Certificates** — **Export CA** to a `.pem`/`.der` file, and **Regenerate CA**
  (proxy must be stopped; re-trust afterwards).
- **Interception** — host exclusions (tunneled, never decrypted/captured).
- **Capture** — max retained flows, **capture filter** (record only matching
  hosts), and **start capturing on launch**.
- **Throttling** — an artificial **response delay** (3G/slow presets) on live
  responses.
- **Columns** — the traffic-list column configuration (above).

### Sessions

Captured/imported traffic lives in memory and is **not** auto-persisted (so
tokens/cookies/bodies don't silently land on disk). Use **Save** to write the
current traffic to a `.germi` session file and **Open** to load one back
(replacing the current list). Scenarios, by contrast, persist automatically.

## Honest limitations

These are inherent to intercepting proxies, not bugs:

- **Certificate pinning** (banking/native/mobile apps) rejects even a trusted CA.
  No proxy can fix this without instrumenting the client.
- **HTTP/3 / QUIC** (UDP 443) escapes a TCP proxy — no Rust MITM library handles
  it. Workaround: block UDP 443 so clients fall back to interceptable HTTP/2.
- **Proxy-unaware apps** (many Go/Rust/Flutter apps) ignore the system proxy.
- **Linux browsers** keep their own NSS trust store — trusting the system CA
  isn't enough; see the in-app dialog for the `certutil` step.

## Roadmap

The MVP deliberately keeps things simple. Natural next steps:

- HTTP/2 interception (enable hudsucker's `http2` feature; mind ALPN).
- WebSocket frame capture/edit (handler is wired as pass-through today).
- Breakpoints (pause/edit request or response live).
- Repeater (edit a captured request and resend).
- SQLite persistence (swap the in-memory store for `rusqlite`, WAL) for sessions
  that survive restarts.
- Body decoding for display (gzip/br) and more inspector views (hex, image).

## License

MIT
