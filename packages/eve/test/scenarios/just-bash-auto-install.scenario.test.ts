import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("just-bash automatic installation", () => {
  it("boots a fresh pnpm app without approving optional native codec builds", async () => {
    const app = await scenarioApp({
      name: "just-bash-auto-install",
      installDependencies: true,
      files: {
        "pnpm-workspace.yaml":
          "minimumReleaseAge: 0\nstrictDepBuilds: true\nallowBuilds:\n  esbuild: true\n",
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
        "agent/instructions.md": "Help with everyday tasks.\n",
        "agent/sandbox/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          'import { JustBashSandbox } from "eve/sandbox/just-bash";',
          "export const environment = JustBashSandbox.environment({",
          "  prepare: async (sandbox) => {",
          '    const result = await sandbox.run({ command: "echo ready" });',
          '    if (result.stdout.trim() !== "ready") throw new Error("Shell preparation failed");',
          "  },",
          "});",
          "export default defineSandbox(() => environment.open());",
        ].join("\n"),
      },
    });
    expect(existsSync(join(app.appRoot, "node_modules", "just-bash"))).toBe(false);

    const server = await startEveDev(app.appRoot);
    try {
      expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
      const policy = await readFile(join(app.appRoot, "pnpm-workspace.yaml"), "utf8");
      expect(policy).toContain("ignoredOptionalDependencies:");
      expect(policy).toContain('"@mongodb-js/zstd"');
      expect(policy).toContain('"node-liblzma"');
      expect(policy).toContain("esbuild: true");
      const manifest = JSON.parse(await readFile(join(app.appRoot, "package.json"), "utf8"));
      expect(manifest.devDependencies["just-bash"]).toBeTruthy();
    } finally {
      await server.stop();
    }
  });
});
