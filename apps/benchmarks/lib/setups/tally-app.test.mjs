import assert from "node:assert/strict";
import { test } from "node:test";

import { tallyAppSetup } from "./tally-app.ts";

test("installs the Tally app in the project directory with eve pinned to the canary", async () => {
  const writes = new Map();
  const commands = [];
  await tallyAppSetup.onSession({
    workspace: "/vercel/sandbox/tally",
    packageSpec: "https://pkg.eve.dev/commit/eve.tgz",
    run: async (command, cwd) => commands.push({ command, cwd }),
    write: async (path, content) => writes.set(path, content),
  });

  const packageJson = JSON.parse(writes.get("package.json"));
  assert.equal(packageJson.dependencies.eve, "https://pkg.eve.dev/commit/eve.tgz");
  for (const file of ["lib/session.ts", "lib/invoices.ts", "app/(dashboard)/layout.tsx"]) {
    assert.ok(writes.has(file), file);
  }
  assert.ok(![...writes.keys()].some((path) => path.startsWith("agent/")));
  assert.deepEqual(commands, [
    { command: "npm install --no-audit --no-fund", cwd: "/vercel/sandbox/tally" },
  ]);
});
