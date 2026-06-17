import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".eve/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Chat UI is a thin wrapper around the eve runtime HTTP surface. Skip the
    // Next.js lints here so it can stay focused on the agent transport contract.
    "app/_chat/**",
  ]),
]);

export default eslintConfig;
