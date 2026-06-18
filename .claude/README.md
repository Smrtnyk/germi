# Germi agent orchestration

A feature-building pipeline for this repo built from Claude Code subagents. You
describe a feature; an **orchestrator** drives specialist agents through
architect → implement → test → QA-validate → review, with an approval gate after
the plan and a verification gate before review.

## Usage

```
/build-feature add a repeater panel that re-sends an edited request
```

This runs the pipeline **in your main conversation** — you see each phase, you
approve the architecture before any code is written, and the results land in your
context. This is the recommended entry point.

Alternatively, `@orchestrator <feature>` (or `claude --agent orchestrator`) runs
the same playbook as an isolated subagent — less visibility, but hands-off.

## The roster (`.claude/agents/`)

| Agent | Role | Edits code? | Model |
|-------|------|-------------|-------|
| `architect` | Plans the change against Germi's 3-layer architecture; maps the IPC chain; defines the test strategy. | no (plan only) | opus |
| `implementor` | Writes the code: engine in `proxy-core`, thin shell in `src-tauri`, `ipc.ts`/`types.ts`/UI wiring. | yes | inherit |
| `tester` | Adds `#[cfg(test)]` unit tests; runs `cargo test -p proxy-core` + `pnpm build`. | tests only | inherit |
| `qa-validator` | The gate: runs CI-equivalent checks + convention audit; returns PASS/FAIL. | no | sonnet |
| `code-reviewer` | Final review for correctness, security, simplification. | no (findings only) | opus |
| `orchestrator` | Coordinates all of the above. | no | opus |

`/build-feature` (`.claude/commands/`) is the canonical playbook the orchestrator
follows.

## How the agents pass context

Subagents have isolated context windows, so each phase writes a structured
artifact and the next phase reads it:

```
.claude/pipeline/<slug>/
  00-request.md         the verbatim feature request
  01-architecture.md    architect's plan
  02-implementation.md  implementor's change summary + file list
  03-tests.md           tests added + run output
  04-qa.md              PASS/FAIL verdict + blocking issues
  05-review.md          review findings
```

`.claude/pipeline/` is gitignored (transient build trails); the agent and command
files are not ignored — commit them so the pipeline is shared with the team.

## What the agents know about this repo

Every agent reads `CLAUDE.md` and bakes in Germi's hard rules: real logic goes in
the GUI-free `proxy-core` engine (the testable source of truth) and `src-tauri`
stays a thin pass-through; the serde↔TS DTO mirror must stay exact; dependencies
are pinned to exact versions; the quality gates are `cargo clippy -p proxy-core
--all-targets -- -D warnings`, `cargo test -p proxy-core`, and `pnpm build`; and
the `src-tauri` shell can't compile without the Linux GTK/WebKit dev libs (so
that gate is honestly marked "deferred" when those libs are absent rather than
claimed as passed).

## Tuning

These are plain Markdown prompt files — edit them. Change a `model:`, tighten a
`tools:` allowlist, add a phase, or adjust the approval-gate / repair-round
policy in `build-feature.md`.
