import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "#internal/nitro/host/build-application.js";
import { startProductionServer } from "#internal/nitro/host/start-production-server.js";

const DELIVERY_SECRET = "workflow-delivery-auth-scenario-secret";

afterEach(() => vi.unstubAllEnvs());

describe("workflow delivery authentication for a configured World", () => {
  const scenarioApp = useScenarioApp();

  it("requires a shared secret at startup and rejects flow deliveries without it", async () => {
    vi.stubEnv("VERCEL", "");
    const app = await scenarioApp({
      name: "world-delivery-auth",
      installDependencies: true,
      dependencies: { "@acme/test-world": "file:./world" },
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4", experimental: { workflow: { world: "@acme/test-world" } } });',
        "agent/instructions.md": "Help Alice plan her week.\n",
        "world/package.json": JSON.stringify({
          name: "@acme/test-world",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        }),
        // Accepts every delivery it is handed, like world-postgres: only
        // eve's proof check stands between the route and the handler.
        "world/index.js": [
          "export function createWorld() {",
          "  return {",
          "    specVersion: 8, events: {},",
          '    createQueueHandler: () => async () => new Response("delivered"),',
          '    getDeploymentId: async () => "test",',
          '    queue: async () => ({ messageId: "msg_1" }),',
          "    runs: { list: async () => ({ cursor: null, data: [], hasMore: false }) },",
          "  };",
          "}",
        ].join("\n"),
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });

    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", undefined);
    await expect(
      promisify(execFile)(process.execPath, [join(app.appRoot, ".output/server/index.mjs")], {
        cwd: app.appRoot,
        env: { ...process.env, PORT: "0" },
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("EVE_WORKFLOW_DELIVERY_SECRET is not set"),
    });

    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", DELIVERY_SECRET);
    const server = await startProductionServer(app.appRoot, { host: "127.0.0.1", port: 0 });
    try {
      const deliver = (headers: Record<string, string>) =>
        fetch(new URL("/.well-known/workflow/v1/flow", server.url), {
          body: JSON.stringify({ task: "Prepare Alice's weekly summary" }),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });

      const unauthenticated = await deliver({});
      expect(unauthenticated.status).toBe(401);
      const trusted = await deliver({ "x-eve-workflow-delivery": DELIVERY_SECRET });
      expect(trusted.status).toBe(200);
      expect(await trusted.text()).toBe("delivered");
    } finally {
      await server.close();
    }
  });
});
