import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

afterEach(() => vi.unstubAllEnvs());

describe("production deployment identity", () => {
  const scenarioApp = useScenarioApp();

  it("reproduces unchanged builds, changes with instructions, and reaches the World on direct Node startup", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
    vi.stubEnv("WORKFLOW_DEPLOYMENT_ID", undefined);
    const app = await scenarioApp({
      name: "build-deployment-id",
      installDependencies: true,
      dependencies: { "@acme/test-world": "file:./world" },
      files: {
        "agent/agent.ts":
          'export default { model: "openai/gpt-5.4", experimental: { workflow: { world: "@acme/test-world" } } };',
        "agent/instructions.md": "Help Alice organize her notes.\n",
        "agent/skills/notes.md": "---\ndescription: Organize notes.\n---\nGroup notes by topic.\n",
        "world/package.json": JSON.stringify({
          name: "@acme/test-world",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        }),
        "world/index.js": [
          'import { writeFileSync } from "node:fs";',
          "export function createWorld() {",
          "  const constructed = process.env.WORKFLOW_DEPLOYMENT_ID;",
          "  const world = {",
          "    specVersion: 8, events: {},",
          '    createQueueHandler: () => async () => new Response("ok"),',
          "    getDeploymentId: async () => process.env.WORKFLOW_DEPLOYMENT_ID,",
          "    start: async () => writeFileSync(process.env.EVE_TEST_DEPLOYMENT_LOG, JSON.stringify({ constructed, started: await world.getDeploymentId() })),",
          "  };",
          "  return world;",
          "}",
        ].join("\n"),
      },
    });
    const profileOutputPath = join(app.appRoot, "build-profile.json");
    const build = async () => {
      await buildApplication(app.appRoot, { profileOutputPath, skipSandboxPrewarm: true });
      return (JSON.parse(await readFile(profileOutputPath, "utf8")) as { deploymentId?: string })
        .deploymentId;
    };
    const firstId = await build();
    expect(firstId).toMatch(/^eve_[a-f0-9]{32}$/);
    expect(await build()).toBe(firstId);
    await writeFile(join(app.appRoot, "agent/instructions.md"), "Help Bob organize his notes.\n");
    const changedId = await build();
    expect(changedId).not.toBe(firstId);
    const logPath = join(app.appRoot, "world-deployment.json");
    vi.stubEnv("EVE_TEST_DEPLOYMENT_LOG", logPath);
    // startProductionServer launches node .output/server/index.mjs, without a CLI bootstrap.
    for (let replica = 0; replica < 2; replica++) {
      const server = await startProductionServer(app.appRoot, { host: "127.0.0.1", port: 0 });
      try {
        expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual({
          constructed: changedId,
          started: changedId,
        });
      } finally {
        await server.close();
      }
    }
  });
});
