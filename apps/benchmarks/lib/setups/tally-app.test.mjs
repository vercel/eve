import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { tallyAppSetup } from "./tally-app.ts";

test("installs Tally with an ai pin from the selected eve canary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-tally-canary-"));
  try {
    const packageDirectory = join(directory, "package");
    mkdirSync(packageDirectory);
    for (const version of ["7.0.172", "7.0.180"]) {
      writeFileSync(
        join(packageDirectory, "package.json"),
        JSON.stringify({ peerDependencies: { ai: `^${version}` } }),
      );
      const archive = join(directory, `eve-${version}.tgz`);
      execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
      const packageSpec = pathToFileURL(archive).href;
      const writes = new Map();
      const commands = [];
      await tallyAppSetup.onSession({
        workspace: "/vercel/sandbox/tally",
        packageSpec,
        run: async (command, cwd) => commands.push({ command, cwd }),
        write: async (path, content) => writes.set(path, content),
      });

      const packageJson = JSON.parse(writes.get("package.json"));
      assert.equal(packageJson.dependencies.eve, packageSpec);
      assert.equal(packageJson.dependencies.ai, version);
      for (const file of ["lib/session.ts", "lib/invoices.ts", "app/(dashboard)/layout.tsx"]) {
        assert.ok(writes.has(file), file);
      }
      assert.ok(![...writes.keys()].some((path) => path.startsWith("agent/")));
      assert.deepEqual(commands, [
        { command: "npm install --no-audit --no-fund", cwd: "/vercel/sandbox/tally" },
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
