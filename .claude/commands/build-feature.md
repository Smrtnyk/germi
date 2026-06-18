---
description: Orchestrate a full feature build for Germi — architect → implement → test → QA-validate → review — by delegating each phase to a specialist subagent. Runs in the main thread for full visibility and an approval gate.
argument-hint: <feature description>
---

# Build a Germi feature (orchestrated)

You are the **orchestrator**. You do not write the architecture, the code, the
tests, or the review yourself — you **coordinate specialist subagents** and own
the hand-offs, the quality gates, and the final report. Run this pipeline in the
**current (main) thread** so the user sees each phase and can intervene.

Feature request:

> $ARGUMENTS

If the request above is empty or too vague to act on, **stop and ask the user**
what they want built (one or two sharp questions), then continue.

## Read this first

Germi is a Rust + Tauri v2 + React HTTP/S debugging proxy. The architecture split
is the single most important thing for every phase to respect:

- `crates/proxy-core/` — the GUI-free **engine + data model + source of truth**.
  All real logic lives here and is unit-tested. Builds/tests standalone.
- `src-tauri/` — a **thin Tauri shell** (IPC commands + event streaming). Cannot
  compile without Linux GTK/WebKit dev libs.
- `src/` — the **React + Vite** frontend.

`CLAUDE.md` is the authoritative convention doc — every specialist agent reads it.

## The pipeline

Track progress with TodoWrite (one todo per phase). Create a pipeline workspace
so each agent can hand structured artifacts to the next:

1. Derive a short kebab-case `<slug>` from the feature (e.g. `repeater-panel`).
2. `mkdir -p .claude/pipeline/<slug>` (it is gitignored).
3. Write the verbatim request to `.claude/pipeline/<slug>/00-request.md`.

Then run the phases below **in order**. Each specialist reads the prior
artifacts and writes its own. Always pass the agent the **`<slug>`, the pipeline
dir, and the paths of the artifacts it must read.**

### Phase 1 — Architect  →  `01-architecture.md`
Delegate to the **architect** agent. It decides which layer(s) the feature
touches, produces a step-by-step implementation plan following Germi's documented
"standard path," lists the exact files to create/modify, maps the full IPC chain
if the feature crosses the boundary, flags gotchas, and defines the test
strategy. It writes code-free; planning only.

**APPROVAL GATE (default):** When the architect returns, summarize its plan for
the user in a few bullets and **ask them to approve or adjust before any code is
written.** Skip this gate only if the user said to run autonomously / "don't stop"
/ "yolo". Incorporate their feedback (re-run the architect if the plan changes
materially) before proceeding.

### Phase 2 — Implementor  →  `02-implementation.md`
Delegate to the **implementor** agent with the approved `01-architecture.md`. It
makes the code changes — engine logic in `proxy-core`, a thin pass-through in
`src-tauri`, and the matching `ipc.ts`/`types.ts`/UI wiring — keeping the
serde↔TS mirror and exact-version pinning intact. It compiles what it can
(`cargo build -p proxy-core`) and writes a change summary + file list.

### Phase 3 — Tester  →  `03-tests.md`
Delegate to the **tester** agent. It adds/extends `#[cfg(test)]` unit tests in
`proxy-core` for the new logic (the standalone, runnable test surface), runs
`cargo test -p proxy-core`, and type-checks the frontend with `pnpm build`. It
reports coverage of the new behavior and the test run output.

### Phase 4 — QA validator  →  `04-qa.md`  (the gate)
Delegate to the **qa-validator** agent. It does **not** fix code — it is the
gatekeeper. It runs the CI-equivalent gates and audits conventions, producing a
**PASS / FAIL** verdict with specific blocking issues:
- `cargo clippy -p proxy-core --all-targets -- -D warnings`
- `cargo test -p proxy-core`
- `pnpm build` (frontend type-check)
- serde↔TS mirror intact; exact-version pins; the standard path followed; no GUI
  dep leaked into `proxy-core`; documented gotchas respected.

**FAIL loop:** If the verdict is FAIL, hand the blocking issues back to the
**implementor** (and **tester** if tests are missing/broken), then re-run the
QA validator. Cap at **2 repair rounds**; if still failing, stop and surface the
remaining issues to the user rather than thrashing.

### Phase 5 — Code reviewer  →  `05-review.md`
Once QA passes, delegate to the **code-reviewer** agent for a final read
(correctness bugs, security, and reuse/simplification). It writes findings only.
Apply any clearly-correct, low-risk fixes yourself (or via a quick implementor
round); leave judgment calls for the user.

## Final report

When the pipeline completes (or stops early), give the user a concise summary:
- **What was built** and which layers/files changed.
- **Verification status**: clippy / `cargo test -p proxy-core` / `pnpm build`
  results, verbatim where it matters. Be honest if a gate was skipped because the
  environment lacks the GTK/WebKit libs (the `src-tauri` shell can't compile
  there) — say so; don't claim it passed.
- **Open review findings / follow-ups** worth the user's attention.
- The path to `.claude/pipeline/<slug>/` for the full trail.

Do not claim the feature is done unless QA passed and you can point to the
evidence. Report skipped or failing steps plainly.
