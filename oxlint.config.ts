import { defineConfig } from "oxlint";

// Frontend lint config for the Germi React/Vite app (src/). The proxy engine is
// Rust (proxy-core / src-tauri) and is covered by clippy, not oxlint.
export default defineConfig({
  plugins: ["react", "react-perf", "typescript", "import", "jsx-a11y"],
  env: {
    browser: true,
    es2024: true,
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
    pedantic: "warn",
  },
  rules: {
    // React 19 uses the automatic JSX runtime (tsconfig "jsx": "react-jsx"), so
    // `React` need not be imported or in scope; this rule is obsolete here.
    "react/react-in-jsx-scope": "off",
    // Side-effect CSS import (`import "./styles.css"` in main.tsx) is idiomatic.
    "import/no-unassigned-import": "off",
    // Pre-existing a11y debt: keep visible as warnings rather than block CI on
    // adoption. Tracked as a follow-up; revisit toward "error" once addressed.
    "jsx-a11y/label-has-associated-control": "warn",
    "jsx-a11y/no-static-element-interactions": "warn",
    "jsx-a11y/click-events-have-key-events": "warn",
    "jsx-a11y/prefer-tag-over-role": "warn",
    "jsx-a11y/no-autofocus": "warn",
  },
  overrides: [
    {
      // Build tooling (e.g. vite.config.ts) runs in Node, not the browser.
      files: ["*.config.ts"],
      env: { node: true },
    },
  ],
});
