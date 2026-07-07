import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two projects share one `pnpm test` run:
//  - "node":    pure, DOM-free logic helpers (`src/**/*.test.ts`) on the fast
//               node environment — no browser, no React.
//  - "browser": React components and DOM hooks (`src/**/*.test.tsx`) in a real
//               headless Chromium via Playwright, so `<dialog>`, the top layer,
//               focus, pointer events and layout behave like production.
// The `.ts` vs `.tsx` split is the routing key: a test that renders a component
// is `.tsx` and runs in the browser; everything else stays `.ts` on node.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "browser",
          include: ["src/**/*.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
            // Screenshot tests (generic `src/components/ui/*` primitives only)
            // compare pixels. Glyph anti-aliasing differs between machines
            // (fonts + FreeType version): `threshold` ignores those small
            // per-pixel color deltas, and `allowedMismatchedPixelRatio` allows
            // the residual. Reference images are committed and generated on the
            // CI image, so CI sees ~0 diff; the budget only absorbs a
            // developer's local OS rendering. A real design regression (wrong
            // color / border / missing variant) moves far more than the budget.
            expect: {
              toMatchScreenshot: {
                comparatorName: "pixelmatch",
                comparatorOptions: { threshold: 0.2, allowedMismatchedPixelRatio: 0.08 },
              },
            },
          },
        },
      },
    ],
  },
});
