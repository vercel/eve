import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const execFileAsync = promisify(execFile);

describe("react-server module maps", () => {
  const scenarioApp = useScenarioApp();

  // `@acme/db` declares `server-only` itself, so the app cannot resolve it
  // under pnpm's strict layout. NODE_OPTIONS conditions resolve through the
  // same `authoredModuleConditions` call; its unit test owns reading them from
  // the environment.
  it.each([
    { conditions: [], expected: "server-only-ready:default" },
    { conditions: ["--conditions=react-server"], expected: "server-only-ready:react-server" },
  ])(
    "builds and serves a channel importing server-only with conditions $conditions",
    async ({ conditions, expected }) => {
      const app = await scenarioApp({
        name: "react-server-module-map",
        installDependencies: true,
        dependencies: { "@acme/condition": "workspace:*", "@acme/db": "workspace:*" },
        files: {
          "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
          "packages/db/package.json": JSON.stringify({
            name: "@acme/db",
            type: "module",
            exports: "./index.ts",
            dependencies: { "server-only": "0.0.1" },
          }),
          "packages/db/index.ts": [
            'import "server-only";',
            'export const message = "server-only-ready";',
            'export async function lookup() { "use step"; return message; }',
          ].join("\n"),
          "packages/condition/package.json": JSON.stringify({
            name: "@acme/condition",
            type: "module",
            exports: { "react-server": "./react-server.js", default: "./default.js" },
          }),
          "packages/condition/react-server.js": 'export const condition = "react-server";',
          "packages/condition/default.js": 'export const condition = "default";',
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "agent/instructions.md": "Reply concisely.",
          // Step modules reach the Nitro bundle directly instead of through the module map.
          "agent/tools/lookup.ts": [
            'import "server-only";',
            'import { defineWorkflowTool } from "eve/tools";',
            'import { lookup } from "@acme/db";',
            'export default defineWorkflowTool({ description: "Look up the message.", inputSchema: {}, async execute() { "use workflow"; return lookup(); } });',
          ].join("\n"),
          "agent/channels/probe.ts": [
            'import { condition } from "@acme/condition";',
            'import { message } from "@acme/db";',
            'import { defineChannel, GET } from "eve/channels";',
            'export default defineChannel({ routes: [GET("/probe", () => new Response(`${message}:${condition}`))] });',
          ].join("\n"),
          "check.mjs": [
            'import { createServer } from "node:net";',
            'import { spawn } from "node:child_process";',
            'import { once } from "node:events";',
            'const portProbe = createServer().listen(0, "127.0.0.1");',
            'await once(portProbe, "listening");',
            "const port = portProbe.address().port;",
            "await new Promise((resolve) => portProbe.close(resolve));",
            'const child = spawn(process.execPath, [".output/server/index.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: "ignore" });',
            'const exited = once(child, "exit");',
            "try {",
            "  for (let attempt = 0; attempt < 100; attempt++) {",
            "    try { const response = await fetch(`http://127.0.0.1:${port}/probe`); if (response.ok) { console.log(await response.text()); break; } } catch {}",
            "    await new Promise((resolve) => setTimeout(resolve, 100));",
            "  }",
            '} finally { if (child.exitCode === null) child.kill("SIGTERM"); await exited; }',
          ].join("\n"),
        },
      });
      await execFileAsync(
        process.execPath,
        [...conditions, join(app.appRoot, "node_modules/eve/bin/eve.js"), "build"],
        {
          cwd: app.appRoot,
          timeout: 90_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const { stdout } = await execFileAsync(process.execPath, ["check.mjs"], {
        cwd: app.appRoot,
        timeout: 20_000,
      });
      expect(stdout.trim()).toBe(expected);
    },
  );
});
