import { access, mkdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prewarmBuiltAppSandboxes } from "#execution/sandbox/prewarm.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

describe("relocated production applications", () => {
  const scenarioApp = useScenarioApp();

  it("prewarms and boots a moved workspace with app and extension TypeScript aliases", async () => {
    const workspace = await scenarioApp({
      name: "relocated-production",
      installDependencies: true,
      dependencies: { "just-bash": "3.1.0" },
      files: {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
        "apps/service/package.json": JSON.stringify({
          name: "relocated-service",
          type: "module",
          dependencies: { "@acme/relocated": "workspace:*" },
        }),
        "apps/service/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./lib/*"] } },
        }),
        "apps/service/lib/marker.ts": 'export const marker = "app-bootstrap";',
        "apps/service/agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "apps/service/agent/instructions.md": "Use the available tools.",
        "apps/service/agent/skills/probe.md":
          "---\ndescription: Probe the sandbox.\n---\nProbe content.",
        "apps/service/agent/sandbox/sandbox.ts": [
          'import { justbash } from "eve/sandbox/just-bash";',
          'import { marker } from "@/marker";',
          "export default {",
          "  backend: justbash(),",
          '  revalidationKey: () => "relocated-v1",',
          "  async bootstrap({ use }) {",
          "    const sandbox = await use();",
          "    const result = await sandbox.run({ command: `echo ${marker}` });",
          '    if (result.stdout.trim() !== "app-bootstrap") throw new Error("Wrong app alias");',
          "  },",
          "};",
        ].join("\n"),
        "apps/service/agent/extensions/acme.ts":
          'import extension from "@acme/relocated"; export default extension();',
        "packages/extension/package.json": JSON.stringify({
          name: "@acme/relocated",
          type: "module",
          exports: "./extension/extension.ts",
          eve: { extension: { source: "source", dist: "extension" } },
        }),
        "packages/extension/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./lib/*"] } },
        }),
        "packages/extension/lib/marker.ts": 'export const marker = "extension-tool";',
        "packages/extension/extension/extension.ts":
          'import { defineExtension } from "eve/extension"; export default defineExtension();',
        "packages/extension/extension/tools/probe.ts": [
          'import { marker } from "@/marker";',
          'if (marker !== "extension-tool") throw new Error("Wrong extension alias");',
          'export default { description: "Probe the extension.", execute: () => marker };',
        ].join("\n"),
        "packages/extension/extension/_manifest.json": JSON.stringify({
          kind: "eve-extension",
          formatVersion: 1,
          builtWithEve: "0.0.0-test",
          requires: { extension: 1, tool: 1 },
        }),
      },
    });
    const root = await realpath(workspace.appRoot);
    const buildRoot = join(root, "build-machine");
    const runtimeRoot = join(root, "runtime-machine");
    await mkdir(buildRoot);
    for (const entry of [
      "apps",
      "packages",
      "node_modules",
      "pnpm-workspace.yaml",
      "package.json",
    ]) {
      await rename(join(root, entry), join(buildRoot, entry));
    }
    const appRoot = join(buildRoot, "apps", "service");
    await buildApplication(appRoot, { skipVercelSandboxPrewarm: false });
    await rename(buildRoot, runtimeRoot);
    await expect(access(buildRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const runtimeAppRoot = join(runtimeRoot, "apps", "service");
    const prewarmedRoots: string[] = [];
    const seededPaths: string[] = [];
    await prewarmBuiltAppSandboxes({
      appRoot: runtimeAppRoot,
      dispatch: async ({ backend, input }) => {
        prewarmedRoots.push(input.runtimeContext.appRoot);
        seededPaths.push(...(input.seedFiles ?? []).map((file) => file.path));
        return await backend.prewarm(input);
      },
    });
    expect(prewarmedRoots).toEqual([runtimeAppRoot]);
    expect(seededPaths).toContain("$HOME/.agents/skills/probe/SKILL.md");

    const server = await startProductionServer(runtimeAppRoot, { host: "127.0.0.1", port: 0 });
    try {
      expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
