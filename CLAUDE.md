# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Germi is a custom, scriptable HTTP/S debugging proxy (a Fiddler/Charles-style
MITM tool) built with **Rust + Tauri v2 + React**, cross-platform on Windows and
Linux. It captures traffic, lets you inspect it, and "auto-responds with your own
sprinkles" — a scenario-based mock/rewrite engine. See `README.md` for the
user-facing feature tour.

## The architecture that matters

Three layers, and the split is the most important thing to understand:

```
crates/proxy-core/   The entire proxy ENGINE + data model. NO GUI dependency.
src-tauri/           Thin Tauri v2 shell: IPC commands + event streaming.
src/                 React + Vite frontend (runs in the system webview).
```

**`proxy-core` is deliberately GUI-free and is the source of truth.** All real
logic — the `hudsucker` MITM proxy, CA generation, the rules/scenario engine, the
flow store, HAR/SAZ import, body decoding, the rule tester — lives here and is
fully unit-tested. It builds and runs on its own (`cargo run -p proxy-core
--example standalone`). **`src-tauri` is a thin wrapper** that drives
`ProxyController` (proxy-core's public API) and forwards events to the webview.

**Consequence for development:** `src-tauri` cannot be compiled without the Linux
WebKitGTK/GTK system libraries (`libwebkit2gtk-4.1-dev` etc.; see README). So
**verify engine changes with `cargo test -p proxy-core`** — that's where the
logic and tests are. The Tauri shell only compiles on a fully-provisioned dev
machine via `pnpm tauri dev`. When adding backend logic, put it in `proxy-core`
(testable) and keep `src-tauri` a trivial pass-through.

### Runtime data flow

The proxy runs **in-process** as a long-lived `tokio` task spawned in Tauri's
`setup()`. Captured flows are pushed to the frontend over a **Tauri Channel**
(`subscribe_flows`), **batched** (~60 ms / 200 events) and carrying only
lightweight summaries — full bodies stay in Rust and are fetched on demand via
`get_flow`. **The IPC bridge, not the proxy, is the bottleneck**; respect that
pattern (batch, lazy-load detail, cap large bodies, virtualize lists, debounce
persistence) rather than streaming everything.

### Key types / call chain

`Flow` (`flow.rs`) = `CapturedRequest` + optional `CapturedResponse`, held in a
bounded `FlowStore` (`store.rs`). `CaptureHandler` (`handler.rs`) implements
hudsucker's traits, runs each request/response through the `AutoResponder`
(`rules.rs`), and records flows via `Shared` (`shared.rs`, the state shared by
every cloned handler). `ProxyController` (`lib.rs`) owns the lifecycle and is the
only public surface. The **AutoResponder** holds many `Scenario`s but exactly one
is active at a time (or none = "Off"); only the active scenario's enabled rules
are evaluated.

## Commands

Frontend / app (from repo root):
- `pnpm install` — install frontend deps.
- `pnpm tauri dev` — run the desktop app with hot reload (recompiles Rust on save).
- `pnpm tauri build` — produce installers (.msi/.exe, .deb/.AppImage/.rpm).
- `pnpm build` — `tsc --noEmit && vite build`; **use this to type-check the
  frontend**.
- `pnpm test` — run the frontend unit tests with Vitest (`src/**/*.test.ts`,
  node env); `pnpm test:watch` for watch mode.

Engine (proxy-core — these work without the GUI system libs):
- `cargo test -p proxy-core` — run all engine tests.
- `cargo test -p proxy-core <name>` — run a single test (e.g.
  `cargo test -p proxy-core off_means_passthrough`).
- `cargo build -p proxy-core` — compile the engine.
- `cargo run -p proxy-core --example standalone` — run the proxy headless.
- `cargo metadata --format-version 1` — validate the whole workspace resolves
  (use this to sanity-check `src-tauri` deps when you can't compile it).

## Adding a feature (the standard path)

1. Implement + unit-test the logic in `proxy-core` (a module + `#[cfg(test)]`),
   exposed through a `ProxyController` method.
2. Add a `#[tauri::command]` in `src-tauri/src/commands.rs` that calls it, and
   register it in the `generate_handler!` list in `src-tauri/src/lib.rs`.
3. Add a wrapper in `src/ipc.ts` and the matching interface in `src/types.ts`.
4. Wire it into the React UI.

## Conventions & gotchas

- **Dependencies are pinned to EXACT versions** — no ranges. Rust uses `=X.Y.Z`
  in `Cargo.toml`; `package.json` uses bare `X.Y.Z` (no `^`). Shared crates
  (serde/serde_json/tokio/tracing) must be pinned to the *same* exact version in
  both `crates/proxy-core` and `src-tauri` or Cargo can't unify them. To bump a
  dep, change the pin and re-run the lockfile; don't add `^`/`~`/`*` ranges.

- **serde ↔ TS mirroring:** every DTO crossing the IPC boundary uses
  `#[serde(rename_all = "camelCase")]` (and `rename_all_fields = "camelCase"` on
  enums — enum-level `rename_all` does NOT rename variant fields). `src/types.ts`
  must mirror these exactly. Use `#[serde(default)]` only where the field is
  semantically optional or an external import format requires leniency.
- **Tauri commands:** async commands must return `Result<_, String>` and must
  **clone the `Arc` out of `State` before any `.await`** (never hold the `State`
  borrow across an await). JS passes camelCase arg names; Rust receives
  snake_case (Tauri converts).
- **Persistence:** the CA (`germi-ca.{pem,key,der}`),
  `autoresponder.sqlite3`, and `settings.json` (proxy-wide settings, e.g. host
  exclusions) live in the OS app-data dir (`AppState.ca_dir`).
  `src-tauri/src/rule_store.rs` owns normalized scenario/rule persistence and
  `src-tauri/src/persist.rs` handles settings. There is deliberately no
  pre-release autoresponder migration path; schema changes may discard old
  development data.
  **Traffic is deliberately NOT auto-persisted** (privacy: captured tokens/bodies
  shouldn't silently hit disk) — it's explicit Save/Open of a lossless `.germi`
  session file (`proxy-core/src/session.rs`, base64 bodies). Don't add background
  flow persistence without a deliberate decision.
- **Body decoding** (gzip/br/deflate) is shared in `proxy-core/src/body.rs`,
  reused by both SAZ import and inspector display. Display bodies are **capped at
  512 KB** (`DISPLAY_CAP` in `flow.rs`) with a `full` fetch flag; base64 is
  skipped for text content-types.
- **Linux display:** `src-tauri/src/main.rs` forces `GDK_BACKEND=x11` +
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux (only if unset) — required for many
  VM/Wayland/GPU setups or the window crashes or renders blank. Users can
  override by exporting those vars.
- **Frontend perf:** the traffic list and inspector body are virtualized
  (`@tanstack/react-virtual`); **CodeMirror is lazy-loaded** (`React.lazy`) in
  `AutoresponderPanel.tsx` so it doesn't bloat startup. Autoresponder IPC carries
  lightweight rule summaries; full headers/bodies are fetched only for the
  selected rule. Keep those boundaries intact.
- **Mock rules are one-per-request, full-URL match** (Fiddler-style, no
  collapsing) — see `respond_rule_from_flow` in `rules.rs`. The `respond` action's
  `headers` field is honored by the engine; Content-Type has its own dedicated
  field, so don't also put content-type in the headers table (avoids duplicates).
- **HTTP/2 is intentionally off** (hudsucker's `http2` feature) for ALPN
  simplicity; everything negotiates HTTP/1.1. HTTP/3/QUIC and cert-pinned traffic
  are out of scope (documented limitations).

## Project state

Feature-rich and usable: capture/inspect (content-aware, decoded bodies),
scenarios + rules + offline tester, HAR/SAZ import, multi-select → mock,
CodeMirror mock editor, rich filtering + backend body search, configurable
traffic columns (timing/TTFB, per-flow comments, pinned-header columns), a
multi-section Settings panel (Connections incl. allow-remote, Certificates
export+regenerate, host exclusion, Capture filter + max-flows + capture-on-start,
response-delay throttling), settings import/export, and `.germi` session
save/open. Provenance is partially covered by the **Mocked-by** column.

Deferred (not started): repeater (edit & resend), breakpoints, WebSocket frame
editing, HTTP/2, upstream/parent-proxy chaining, SQLite-backed persistent store.
