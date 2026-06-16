#!/usr/bin/env node
/**
 * CI lint that fails if a `packages/eve/test/fixtures/` tree appears.
 * Committed fixture trees are not allowed: scenario-tier app content is
 * defined as inline `ScenarioAppDescriptor` objects under
 * `packages/eve/src/internal/testing/scenario-apps/`. Contributors who
 * try to add a fixture tree get a loud failure pointing at the
 * descriptor pattern instead.
 */
import { access, constants as fsConstants } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = resolve(
  fileURLToPath(new URL("../packages/eve/test/fixtures", import.meta.url)),
);

async function main() {
  try {
    await access(FIXTURES_ROOT, fsConstants.F_OK);
  } catch {
    process.stdout.write("[eve:guard] ok — packages/eve/test/fixtures/ does not exist.\n");
    return;
  }

  process.stderr.write(
    [
      "[eve:guard] FAIL: packages/eve/test/fixtures/ exists.",
      "",
      "Committed fixture trees are not allowed in this repo.",
      "Add new scenario-tier app content as a `ScenarioAppDescriptor` under",
      "`packages/eve/src/internal/testing/scenario-apps/` and materialize it with",
      "`materializeScenarioApp()` / `useScenarioApp()` from `src/internal/testing/scenario-app.ts`.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

await main();
