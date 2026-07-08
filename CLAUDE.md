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
- `pnpm test` — run the frontend unit tests with Vitest. **Two projects share
  one run** (`vitest.config.ts`): a **node** project for pure DOM-free logic
  (`src/**/*.test.ts`) and a **browser** project that renders React components and
  DOM hooks (`src/**/*.test.tsx`) in a real headless Chromium via Playwright
  (`@vitest/browser-playwright`). The `.ts`/`.tsx` extension is the routing key.
  `pnpm test:watch` for watch mode. CI runs `npx playwright install chromium`
  before `pnpm test` for the browser project (browsers are not bundled).

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
  `src-tauri/src/persist.rs` handles settings. On writable open, `rule_store`
  self-heals a DB written by an older schema (column diff → rebuild, preserving
  rules via their stored `rule_json`; viewer instances never heal). Schema
  changes must keep that self-heal working — an existing DB must still load —
  with a `cargo test -p germi` test proving it.
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
- **Frontend tests — `.ts` is node, `.tsx` is browser:** pure DOM-free helpers
  are tested on the fast node project as `src/<module>.test.ts` (build inputs with
  small factories — see `flowFixtures.ts` — and assert through the public API).
  Anything that **renders a component or drives a DOM hook** is a `src/**/*.test.tsx`
  file on the **browser** project (real Chromium), using **`vitest-browser-react`**:
  `const screen = await render(<Comp .../>)` (render is async!), query with
  `screen.getByRole(...)`, assert with `await expect.element(loc).toBeVisible()`,
  interact with `await loc.click()` / `userEvent` from `"vitest/browser"`, and use
  `vi.fn()` for callbacks. Prefer the browser project for components precisely
  because `<dialog>.showModal()`, the top layer, focus and pointer geometry behave
  like production (jsdom fakes them). See `ConfirmDialog.test.tsx` for the idiom and
  `.claude/skills/browser-testing/SKILL.md` for the full reference. Components that
  pull in Tauri IPC are not directly renderable — keep presentational pieces
  prop-driven so they stay testable.
- **Frontend utilities — reuse es-toolkit:** the frontend depends on
  **es-toolkit** (`package.json`, exact-pinned, zero transitive deps). Reach for
  its pure helpers instead of hand-rolling them — `clamp`, `debounce`/`throttle`,
  `compact`, `countBy`/`sumBy`, `difference`/`intersection`, `uniqBy`, `groupBy`,
  `isEqual`, `isPlainObject`, `inRange`, etc. Import from the main entry
  (`import { clamp } from "es-toolkit"`); don't reinvent the wheel or add lodash.
  Keep it to **genuine** reuse — don't wrap a plain `.map`/`.filter` in a helper
  just to use the library.
- **Frontend icons — use the central `src/components/icons.tsx`:** every UI icon
  is a named export from this module (backed by **react-icons**, exact-pinned).
  Prominent/branded actions use vivid Flat-Color (`fc`) icons; status/markers use
  semantically-tinted lucide (`lu`) icons (colors are `var(--*)` tokens); dense
  repeated controls use `currentColor` lucide so they inherit hover/active color.
  Don't hand-place raw Unicode glyphs as icons or import `react-icons` directly in
  a component — add/reuse an export here. Keyboard-hint typography (`⌘`, the arrow
  keys, `→` inside a sentence/label) is NOT an icon — leave it as text.
- **Generic UI primitives — `src/components/ui/`:** the reusable, prop-driven
  building blocks — `Button`, `SegmentedControl`, `Chip`, `FilterChip` (kind /
  status quick-filters, `.fchip`), `IconButton` (bare icon closers, `.icon-btn`)
  and `Modal` (the shared `<dialog>` + `useModalDialog` shell, `close()` via a
  render-prop) — that render the shared design-system classes so every button,
  segmented switch, pill, icon affordance and dialog looks and behaves the same
  (issue #64). Reach for these instead of hand-writing `<button className="btn …">`
  / `<div className="seg">` / `<dialog className="modal">`; context-specific hooks
  still ride along via `className`. These primitives are
  the **only** components with screenshot tests (`toMatchScreenshot`) — a pixel
  baseline that locks their look. Don't screenshot-test feature components, and
  regenerate the committed references in the pinned Playwright container when a
  primitive's look changes (see `.claude/skills/browser-testing/SKILL.md`).
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
save/open. Settings import/export is **partial by section** (issue #112): a
checklist dialog (`SettingsSectionsDialog.tsx`) picks what to export, and import
is two-phase (`peek_settings_import` previews the picked file's sections →
`apply_settings_import` merges only the selected, present fields — the file text
waits in an `AppState` mailbox). The section registry + filter/preview/merge
logic lives in `proxy-core/src/settings_io.rs`; a test forces every
`ProxySettings` field into exactly one section, so extend `SETTINGS_SECTIONS`
when adding a field. Provenance is covered by the **Mocked-by** column and an **imported**
row marker (flows loaded from a file carry `Flow::imported`; shown as a violet
left-bar + optional **Origin** column, filterable with `is:imported`/`is:captured`),
with a **Delete captured** action (`remove_captured_flows`) that prunes live
traffic while keeping the imported reference (issue #49).

**Compare & diff** (issue #86): select rows → Compare opens a real, singleton
**compare OS window** (label `compare`, rule-window pattern: `?compare=1` route
in `main.tsx` → `CompareWindow.tsx`; the shared open-or-focus helper lives in
`windows.ts`). The seed travels as flow ids through a backend mailbox
(`set_compare_seed`/`get_compare_seed` on `AppState` — no URL-length limits,
survives webview reloads; re-invoking Compare re-seeds the open window via the
`germi://compare-seed-changed` event). Two-pane picker (`CompareView.tsx`;
exactly 2 selected prefills both sides): each pane is a mini traffic list —
token filter (reuses `parseFilter`), kind chips, sortable columns, shift/ctrl
multi-select (`comparePane.ts` holds the pure list/selection/move pipeline) —
with per-row **URL-match %** badges (`urlSimilarity.ts` — structural: host
labels / path-segment LCS / query-param overlap; ≥80% rows get a per-side
full-row tint). Pane filters are **linked** by default (issue #88): text/kind
edits mirror to both sides (sort stays per-pane), with an unlink toggle +
copy-across buttons atop the gutter (`CompareGutter.tsx`); re-linking keeps
the only filled-in filter, preferring the left (`linkSourceSide` /
`copyPaneFilter` in `comparePane.ts`). Move the selection across via →/← or
**Load file…**
(`append_capture` — appends a HAR/SAZ/.germi to the store WITHOUT clearing,
unlike `open_capture`), then a raw-HTTP diff (`diff.ts` LCS with folded
context, `DiffView.tsx`) — **side-by-side by default** (`splitRows` pairs
del/add runs; toggle to unified, persisted). Bodies are compared decoded in
the engine (`compare_bodies` / `compare_flow_bodies`) so payloads never cross
IPC; hunks render only on an explicit toggle and use the display-capped body.

**Configurable highlight colors** (issue #93): every row/diff highlight is a
`:root` token; Settings → Appearance edits them as color+opacity pairs. The
sparse override map lives in `ProxySettings.highlight_colors` (rides
persistence + import/export), the registry/parse/apply logic in `src/theme.ts`
(specs carry `defaultValue` mirroring `:root` — guarded by a browser test —
and the diff specs derive their `-hl` intra-line mark at 3× alpha).
`main.tsx` applies overrides in every window via `initHighlightColorSync`
(`themeSync.ts`), re-applying on the frontend-emitted
`germi://settings-changed` event; the Appearance section previews by writing
the custom properties live and commits once per interaction (native `change`).
Rows also take direct hex entry (6-digit keeps the row's opacity, 8-digit
sets it — `parseHexEntry`) and drag-a-swatch-onto-another-row hue copy
(`COLOR_DRAG_MIME` in `dnd.ts`; drops copy the hue, never the opacity).

Deferred (not started): repeater (edit & resend), breakpoints, WebSocket frame
editing, HTTP/2, upstream/parent-proxy chaining, SQLite-backed persistent store.
