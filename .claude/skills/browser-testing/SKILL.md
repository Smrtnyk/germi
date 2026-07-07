---
name: browser-testing
description: Write or debug Vitest browser-mode tests for Germi's React components and DOM hooks (vitest-browser-react + Playwright Chromium). Use when adding/fixing a `src/**/*.test.tsx` file, or deciding whether a test belongs in the node or browser project.
---

# Browser-mode component testing (Germi)

Germi's frontend tests run under **Vitest 4** with **two projects in one
`pnpm test` run** (`vitest.config.ts`), routed purely by file extension:

| File             | Project   | Environment                          | For                                  |
| ---------------- | --------- | ------------------------------------ | ------------------------------------ |
| `*.test.ts`      | `node`    | node (fast, no DOM)                  | pure DOM-free logic helpers          |
| `*.test.tsx`     | `browser` | real headless **Chromium** (Playwright) | React components + DOM hooks      |

So **the `.ts`/`.tsx` extension is the decision**: if the test renders a
component or drives a hook that touches the DOM/`window`, name it `.tsx` and it
runs in a real browser. Otherwise keep it `.ts` on node.

## Why a real browser (not jsdom)

The browser project exists for behavior jsdom fakes or gets wrong:
`<dialog>.showModal()` + the top layer, `Esc`-to-close, real focus, pointer
geometry / `getBoundingClientRect`, viewport-clamped popups, CSS-driven layout.
If a test doesn't need any of that, it's pure logic — put it on node.

## The stack

- `vitest-browser-react` — `render` / `renderHook` / `cleanup` (auto-cleanup runs
  `beforeEach`). Returns **locators**, not raw nodes.
- `@vitest/browser-playwright` — the provider **factory** wired in
  `vitest.config.ts` as `provider: playwright()` (Vitest 4 takes a factory, not
  the old `"playwright"` string). `instances: [{ browser: "chromium" }]`,
  `headless: true`.
- `vitest/browser` — the in-browser context: `page`, `userEvent`. (Import from
  `"vitest/browser"`, **not** the deprecated `"@vitest/browser/context"`.)
- Matchers (`toBeVisible`, `toHaveClass`, `toBeInTheDocument`, `toHaveTextContent`,
  `toBeDisabled`, `toBeChecked`, `toHaveAttribute`, …) are auto-registered — no
  setup file, no `@testing-library/jest-dom` import, and they type-check as-is.

## The proven idiom

`src/components/ConfirmDialog.test.tsx` is the canonical example. The shape:

```tsx
import { userEvent } from "vitest/browser";          // only if you need keyboard/hover/etc.
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("calls onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    const screen = await render(                       // render is ASYNC — await it
      <ConfirmDialog title="P" message="g" confirmLabel="Yes" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    await screen.getByRole("button", { name: "Yes" }).click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
```

### Hard rules (learned the hard way)

1. **`render` is async** — always `const screen = await render(<Comp .../>)`.
   Forgetting `await` makes `screen.getByRole` "not a function".
2. **Query through the returned object** (bound to `document.body`):
   `screen.getByRole`, `getByText`, `getByPlaceholder`, `getByLabelText`,
   `getByTitle`, `getByTestId`. The global `page` from `"vitest/browser"` has the
   same selectors (handy for asserting **absence** without a render handle).
3. **Assert on elements with `expect.element` and `await`**:
   `await expect.element(loc).toBeVisible()` / `.toHaveClass("on")` /
   `.toHaveTextContent("…")` / `.toBeDisabled()`. Absence:
   `await expect.element(loc).not.toBeInTheDocument()`. Plain values (mock calls,
   returned ids) use bare `expect(...)`.
4. **Interact** (all async): `await loc.click()`, `await loc.fill("text")` (inputs
   — sets value + fires input), and from `userEvent`: `keyboard("{Escape}")` /
   `keyboard("{ArrowDown}")`, `hover(loc)` / `unhover(loc)`, `tab()`.
5. **Callbacks are `vi.fn()`**; assert `toHaveBeenCalledOnce()` /
   `toHaveBeenCalledWith(...)` / `.not.toHaveBeenCalled()`.
6. **Auto-cleanup** runs before each test. If you render **twice in one test**,
   `await result.unmount()` between renders.
7. **No comments** in test files (project rule), no `.skip`/`.todo`, no
   `console.log`. Keep lines ≤ 100 cols and each `it` body simple (the **fallow**
   gate caps cyclomatic/cognitive complexity — push shared setup into a small
   factory like `flowFixtures.ts`).

### Hooks — `renderHook`

```tsx
import { renderHook } from "vitest-browser-react";

const { result } = await renderHook(() => useResizable({ initial: 200, min: 100, getMax: () => 1000, storageKey: "k" }));
expect(result.current.size).toBe(200);
```

`renderHook` is async and awaits mount effects, so `result.current` already
reflects mount-time clamping. Use a **unique `storageKey` per test** and
`localStorage.removeItem` it, since the browser persists between tests.

For stateful hooks driven by callbacks (e.g. `useToasts`), a tiny **Harness**
component that uses the hook and renders buttons + the presentational component is
often more robust than poking `result.current` — you drive it with real clicks.

## What to test (and what not to)

- **Do** test presentational, prop-driven components — the ones that take
  callbacks as props and **don't import Tauri IPC**: `ConfirmDialog`, `Tooltip`,
  `ContextMenu`, `CommandPalette`, `FilterChips`, `StatusBar`,
  `ToastHost`/`useToasts`, `MatchRail` (render/hide wiring).
- **Don't** try to render `App`, `AutoresponderPanel`, `FlowInspector`,
  `SettingsDialog`, etc. — they pull in `ipc.ts` (`@tauri-apps/api`), which isn't
  available in the test browser. Keep components presentational so they stay
  testable; push IPC to the edges.
- **Don't** re-test pure logic in the browser. `matchRail.ts`'s math is covered by
  `src/matchRail.test.ts` (node); the `MatchRail.test.tsx` only checks the
  visible/hidden wiring, not the geometry.
- **Don't** assert exact pixel coordinates or rely on app CSS being loaded (it
  isn't imported in tests) — assert structure, roles, text, classes, and
  callbacks.

## Running

```sh
pnpm test                                  # both projects
pnpm test src/components/Foo.test.tsx       # one file (launches Chromium for it)
pnpm test -t "treats an Escape"             # by test name
```

First time / CI: `pnpm exec playwright install chromium` (browsers aren't
bundled; CI does this before `pnpm test`). After a *failing* screenshot run
vitest leaves actual/diff images under `.vitest/` and `.vitest-attachments/` —
both git-ignored. Committed **reference** screenshots (under
`src/components/ui/**/__screenshots__/`) are NOT ignored — they are the
visual-regression baselines.

## Screenshot tests (generic `ui/` primitives ONLY)

The reusable primitives in `src/components/ui/` (`Button`, `SegmentedControl`,
`Chip`) are pixel-locked with `toMatchScreenshot` so their look can't regress
(issue #64). **Only these generic components get screenshot tests** — never a
feature component. The idiom:

```tsx
import "../../styles.css";                 // screenshots need the real CSS
// render a compact gallery of every variant into a fixed-size element…
await expect.element(screen.getByTestId("gallery")).toMatchScreenshot("button-gallery");
```

- Each `ui/<Name>.test.tsx` mixes a few DOM/behavior `it`s (roles, `.on`/variant
  classes, `onClick`) with **one** `toMatchScreenshot` gallery `it`.
- **A text gallery must `await loadScreenshotFont()` before rendering** (see
  `ui/screenshotFont.ts`). It pins a bundled Open Sans on `<body>` so text
  metrics — and therefore element **dimensions** — are identical everywhere. CI
  (ubuntu-noble) substitutes a different `system-ui` than a dev box; without the
  bundled font the galleries render a few px shorter/taller and
  `toMatchScreenshot` **hard-fails on mismatched dimensions before the pixel
  tolerance even applies**. An icon-only gallery (IconButton) has no text, so it
  skips this.
- **Reference images are generated on the CI image**, not your machine — glyph
  anti-aliasing differs across OS/FreeType versions. Regenerate them in the
  pinned Playwright container so CI sees ~0 diff:
  ```sh
  podman run --rm --ipc=host --cap-add=SYS_ADMIN -v "$PWD":/work:Z -w /work \
    mcr.microsoft.com/playwright:v1.61.1-noble \
    bash -lc './node_modules/.bin/vitest run src/components/ui/'
  ```
  Run it **twice** (first run creates the reference and "fails"; second passes),
  then commit the PNGs under `__screenshots__/`. `vitest.config.ts` sets a
  `pixelmatch` tolerance (`threshold: 0.2`, `allowedMismatchedPixelRatio: 0.08`)
  that absorbs a local machine's rendering while still catching real
  color/shape regressions.

## Gotchas seen in this repo

- `provider: "playwright"` (string) → **error in Vitest 4**. Use the factory:
  `import { playwright } from "@vitest/browser-playwright"; provider: playwright()`.
- Importing `userEvent`/`page` from `"@vitest/browser/context"` works but logs a
  **deprecation**; import from `"vitest/browser"` instead.
- A `disabled` button swallows clicks — assert `.toBeDisabled()` and that its
  handler was **not** called, rather than clicking and expecting a no-op silently.
- `pnpm build` (`tsc`) type-checks `*.test.tsx` too, so the test must compile —
  the browser matcher types resolve with no extra config.
