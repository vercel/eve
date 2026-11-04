import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const runFile = promisify(execFile);
const scenarioApp = useScenarioApp();

// A packed npm install outside the workspace, where pnpm's hoisting cannot
// hand Nitro a dependency eve did not declare.
describe("packed host build", () => {
  it("builds with eve's own Rolldown and leaves the app's dependencies alone", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
        "agent/instructions.md": "You are a precise assistant.\n",
      },
      installDependencies: true,
      name: "packed-host-build",
      packageManager: "npm",
    });
    const manifestFiles = ["package.json", "package-lock.json"];
    const manifestsBefore = await Promise.all(
      manifestFiles.map(async (file) => await readFile(join(app.appRoot, file))),
    );
    // Nitro installs missing packages silently in CI, so leave CI unset.
    const { CI: _ci, ...env } = process.env;

    const { stderr, stdout } = await runFile(
      process.execPath,
      [join(app.appRoot, "node_modules", "eve", "bin", "eve.js"), "build"],
      { cwd: app.appRoot, env, maxBuffer: 20 * 1024 * 1024 },
    );

    const output = `${stdout}\n${stderr}`;
    expect(output).not.toMatch(/install(?:ing)? automatically|is not installed|deprecat/i);
    for (const [index, file] of manifestFiles.entries()) {
      expect(await readFile(join(app.appRoot, file)), file).toEqual(manifestsBefore[index]);
    }

    const manifest = async (path: string) =>
      JSON.parse(await readFile(join(app.appRoot, "node_modules", path, "package.json"), "utf8"))
        .dependencies as Record<string, string> | undefined;
    expect((await manifest("eve"))?.rolldown).toBeDefined();
    expect((await manifest("nitro"))?.rolldown).toBeUndefined();
    const { stdout: rolldownInstances } = await runFile("npm", ["query", "#rolldown"], {
      cwd: app.appRoot,
    });
    expect(JSON.parse(rolldownInstances)).toHaveLength(1);

    const hostedFiles = await readdir(join(app.appRoot, ".output"), { recursive: true });
    expect(
      hostedFiles.filter((file) => /(?:^|[/\\])(?:@?rolldown|unstorage)(?:[/\\.+]|$)/.test(file)),
    ).toEqual([]);
  }, 240_000);
});
