import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

// Root `pnpm build` only builds `./packages/*`, so this is the only check that
// the example apps under `apps/frameworks` still build against the workspace
// eve dist. A non-zero exit from the fixture's own build is the failure signal.
describe("framework fixtures", () => {
  it.each(["framework-next", "framework-nuxt", "framework-sveltekit"])(
    "builds the %s fixture against the workspace eve dist",
    async (fixture) => {
      await runPnpmCommand({
        args: ["--filter", fixture, "build"],
        cwd: REPO_ROOT,
      });
    },
    300_000,
  );
});
