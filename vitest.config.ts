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
          },
        },
      },
    ],
  },
});
