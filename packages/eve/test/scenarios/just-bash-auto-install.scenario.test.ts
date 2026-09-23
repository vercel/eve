import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { readDevelopmentRevision, startEveDev, waitForCondition } from "./dev-server-harness.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

const scenarioApp = useScenarioApp();

describe("just-bash automatic installation", () => {
  it("defers installation until sandbox access without approving optional native codec builds", async () => {
    const app = await scenarioApp({
      name: "just-bash-auto-install",
      installDependencies: true,
      dependencies: { zod: "4.5.4" },
      files: {
        "pnpm-workspace.yaml":
          "minimumReleaseAge: 0\nstrictDepBuilds: true\nallowBuilds:\n  esbuild: true\n",
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
        "agent/instructions.md": "Help with everyday tasks.\n",
        "agent/tools/check_shell.ts": [
          'import { defineTool } from "eve/tools";',
          'import { z } from "zod";',
          'export default defineTool({ description: "Check the shell", inputSchema: z.object({}),',
          '  async execute(_input, ctx) { const sandbox = await ctx.getSandbox(); return await sandbox.run({ command: "echo lazy-ready" }); },',
          "});",
        ].join("\n"),
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
      expect(existsSync(join(app.appRoot, "node_modules", "just-bash"))).toBe(false);
      expect(existsSync(join(app.appRoot, "node_modules", "microsandbox"))).toBe(false);
      expect(await readFile(join(app.appRoot, "pnpm-workspace.yaml"), "utf8")).not.toContain(
        "ignoredOptionalDependencies:",
      );
      const sessions = [createDevelopmentSessionState(), createDevelopmentSessionState()];
      const results = await Promise.all(
        sessions.map((session) =>
          sendDevelopmentMessage({
            message: "Run check_shell",
            session,
            serverUrl: server.url,
          }),
        ),
      );
      for (const result of results) {
        expect(JSON.stringify(result.events), `${server.stdout()}\n${server.stderr()}`).toContain(
          "lazy-ready",
        );
      }
      const policy = await readFile(join(app.appRoot, "pnpm-workspace.yaml"), "utf8");
      expect(policy).toContain("ignoredOptionalDependencies:");
      expect(policy).toContain('"@mongodb-js/zstd"');
      expect(policy).toContain('"node-liblzma"');
      expect(policy).toContain("esbuild: true");
      const manifest = JSON.parse(await readFile(join(app.appRoot, "package.json"), "utf8"));
      expect(manifest.devDependencies["just-bash"]).toBeTruthy();

      const initialRevision = await readDevelopmentRevision(server.url);
      await writeFile(
        join(app.appRoot, "agent", "instructions.md"),
        "Help with everyday tasks and check the shell when asked.\n",
      );
      await waitForCondition(
        async () => (await readDevelopmentRevision(server.url)) !== initialRevision,
        () => `Expected authored rebuild.\n${server.stdout()}\n${server.stderr()}`,
      );
      const resumed = await sendDevelopmentMessage({
        message: "Run check_shell",
        session: sessions[0]!,
        serverUrl: server.url,
      });
      expect(JSON.stringify(resumed.events), `${server.stdout()}\n${server.stderr()}`).toContain(
        "lazy-ready",
      );
    } finally {
      await server.stop();
    }
  });
});
