import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const execFileAsync = promisify(execFile);

describe("react-server module maps", () => {
  const scenarioApp = useScenarioApp();

  it.each(["none", "argument", "NODE_OPTIONS"])(
    "builds and loads server-only channels (conditions: %s)",
    async (conditionSource) => {
      const app = await scenarioApp({
        name: "react-server-module-map",
        installDependencies: true,
        dependencies: { "@acme/shared": "link:./shared", "server-only": "0.0.1" },
        files: {
          "shared/package.json": JSON.stringify({
            name: "@acme/shared",
            type: "module",
            exports: "./index.ts",
          }),
          "shared/index.ts": 'import "server-only"; export const message = "server-only-ready";',
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "agent/instructions.md": "Reply concisely.",
          "agent/channels/probe.ts":
            'import "server-only"; import { message } from "@acme/shared"; import { defineChannel, GET } from "eve/channels"; export default defineChannel({ routes: [GET("/probe", () => new Response(message))] });',
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
        [
          ...(conditionSource === "argument" ? ["--conditions=react-server"] : []),
          join(app.appRoot, "node_modules/eve/bin/eve.js"),
          "build",
        ],
        {
          cwd: app.appRoot,
          timeout: 90_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            ...(conditionSource === "NODE_OPTIONS"
              ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions="react-server"` }
              : {}),
          },
        },
      );
      const { stdout } = await execFileAsync(process.execPath, ["check.mjs"], {
        cwd: app.appRoot,
        timeout: 20_000,
      });
      expect(stdout).toContain("server-only-ready");
    },
  );
});
