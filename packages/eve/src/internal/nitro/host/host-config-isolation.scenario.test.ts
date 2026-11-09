import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

describe("host configuration isolation", () => {
  const scenarioApp = useScenarioApp();

  it("builds and serves without the app root's Nitro config, server entry, or index.html", async () => {
    const app = await scenarioApp({
      name: "host-config-isolation",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Answer briefly.",
        // Each config source breaks eve's host build if Nitro merges it.
        "nitro.config.ts": [
          "export default {",
          "  hooks: {",
          '    "build:before"() {',
          `      throw new Error("The app's nitro.config reached eve's host.");`,
          "    },",
          "  },",
          "};",
        ].join("\n"),
        ".nitrorc": "preset=eve-unknown-preset\n",
        // Either file would answer requests no eve route matches.
        "server.ts": 'export default { fetch: () => new Response("app server entry") };\n',
        "index.html": "<html><body>app renderer template</body></html>\n",
      },
    });
    const appRoot = await realpath(app.appRoot);
    const packageJsonPath = join(appRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as object;
    await writeFile(
      packageJsonPath,
      JSON.stringify({ ...packageJson, nitro: { preset: "eve-unknown-package-preset" } }),
    );

    await expect(buildApplication(appRoot, { skipSandboxPrewarm: true })).resolves.toBe(
      join(appRoot, ".output"),
    );
    const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
    try {
      const unmatched = await fetch(new URL("/no-such-route", server.url));
      expect(unmatched.status).toBe(404);
      expect(await unmatched.text()).not.toMatch(/app server entry|app renderer template/);
    } finally {
      await server.close();
    }
  });
});
