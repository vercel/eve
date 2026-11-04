import { afterEach, describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "#internal/nitro/host/build-application.js";
import { startProductionServer } from "#internal/nitro/host/start-production-server.js";
import {
  signWorkflowDelivery,
  WORKFLOW_DELIVERY_HEADER,
} from "#internal/workflow/world-delivery-auth.js";

const DELIVERY_SECRET = "workflow-delivery-auth-scenario-secret";

afterEach(() => vi.unstubAllEnvs());

describe("workflow delivery authentication for a configured World", () => {
  const scenarioApp = useScenarioApp();

  it("leaves deliveries open without a secret and rejects unsigned ones with it", async () => {
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
        // eve's proof check stands between the route and the handler. The
        // Workflow handler rejects this test message, so its error is ignored.
        "world/index.js": [
          "export function createWorld() {",
          "  return {",
          "    specVersion: 8, events: {},",
          "    createQueueHandler: (_prefix, handler) => async (request) => {",
          "      const queueName = request.headers.get('x-vqs-queue-name');",
          "      await handler(await request.json(), { attempt: 1, messageId: 'msg_1', queueName }).catch(() => {});",
          '      return new Response("delivered");',
          "    },",
          '    getDeploymentId: async () => "test",',
          '    queue: async () => ({ messageId: "msg_1" }),',
          "    runs: { list: async () => ({ cursor: null, data: [], hasMore: false }) },",
          "  };",
          "}",
        ].join("\n"),
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });

    const queueName = "__wkf_workflow_entry";
    const message = { runId: "wrun_1", task: "Prepare Alice's weekly summary" };
    const deliver = (serverUrl: string, proof?: string) => {
      const headers = new Headers({
        "content-type": "application/json",
        "x-vqs-queue-name": queueName,
      });
      if (proof !== undefined) headers.set(WORKFLOW_DELIVERY_HEADER, proof);
      return fetch(new URL("/.well-known/workflow/v1/flow", serverUrl), {
        body: JSON.stringify(message),
        headers,
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    };

    // Without a secret, authentication stays off and the World gets every delivery.
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", undefined);
    const open = await startProductionServer(app.appRoot, { host: "127.0.0.1", port: 0 });
    try {
      const unauthenticated = await deliver(open.url);
      expect(unauthenticated.status).toBe(200);
      expect(await unauthenticated.text()).toBe("delivered");
    } finally {
      await open.close();
    }

    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", DELIVERY_SECRET);
    const server = await startProductionServer(app.appRoot, { host: "127.0.0.1", port: 0 });
    try {
      expect((await deliver(server.url)).status).toBe(401);
      // A secret on its own is not a proof for any message.
      expect((await deliver(server.url, DELIVERY_SECRET)).status).toBe(401);
      const otherMessage = signWorkflowDelivery(DELIVERY_SECRET, queueName, { runId: "wrun_2" });
      expect((await deliver(server.url, otherMessage)).status).toBe(401);
      const trusted = await deliver(
        server.url,
        signWorkflowDelivery(DELIVERY_SECRET, queueName, message),
      );
      expect(trusted.status).toBe(200);
      expect(await trusted.text()).toBe("delivered");
    } finally {
      await server.close();
    }
  });
});
