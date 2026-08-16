// Minimal flat ESLint config (eslint 9 + typescript-eslint).
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".export-stage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentional `_`-prefixed unused args/vars.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Standalone Node scripts (e.g. the E1 merge harness, the Lane F tools):
    // give them Node globals.
    files: ["scripts/**/*.{js,mjs}", "tools/**/*.{js,mjs}"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly" },
    },
  },
);
