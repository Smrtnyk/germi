import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["react", "react-perf", "typescript", "import"],
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
    "react/react-in-jsx-scope": "off",
    "import/no-unassigned-import": "off",
    eqeqeq: ["error", "smart"],
    "max-lines-per-function": "off",
    "max-lines": "off",
    "import/max-dependencies": "off",
    "no-inline-comments": "off",
    "require-unicode-regexp": "off",
    "react/no-unescaped-entities": "off",
    "no-negated-condition": "off",
  },
  overrides: [
    {
      files: ["*.config.ts"],
      env: { node: true },
    },
  ],
});
