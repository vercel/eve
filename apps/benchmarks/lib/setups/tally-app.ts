import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuthoringSetup } from "../authoring-case.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/tally/", import.meta.url));

/** The Tally app's source files, keyed by their path inside the app. */
export function tallyAppFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(fixtureRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(fixtureRoot, path)] = readFileSync(path, "utf8");
  }
  return files;
}

/**
 * Tally's `package.json`. A teammate already added eve, pinned to the canary under test, so the
 * coding agent's own installs don't swap in a different release.
 */
export function tallyPackageJson(packageSpec: string): string {
  const packageJson = {
    name: "tally",
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      ai: "7.0.137",
      eve: packageSpec,
      next: "16.3.8",
      react: "19.2.6",
      "react-dom": "19.2.6",
      zod: "4.5.4",
    },
    devDependencies: {
      "@types/node": "26.6.5",
      "@types/react": "19.2.15",
      "@types/react-dom": "19.2.3",
      typescript: "6.0.3",
    },
  };
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

/** An existing Next.js invoicing app in the case's project directory, with dependencies installed. */
export const tallyAppSetup: AuthoringSetup = {
  id: "tally-app-v1",
  async onSession({ packageSpec, run, workspace, write }) {
    const files = { ...tallyAppFiles(), "package.json": tallyPackageJson(packageSpec) };
    for (const [path, content] of Object.entries(files)) await write(path, content);
    await run("npm install --no-audit --no-fund", workspace);
  },
};
