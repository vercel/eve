import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

const CLOSE_DELAY_MS = 1_000;

/**
 * A configured Workflow World whose `close()` takes a second and records
 * each phase in the server's working directory. A world such as
 * `world-postgres` releases in-flight queue jobs in `close()`, so a server
 * that exits before `close()` settles leaves those jobs locked (#1981).
 */
const PROBE_WORLD_SOURCE = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const record = (phase) => appendFileSync(join(process.cwd(), "world-close.log"), phase + "\\n");

export function createWorld() {
  return {
    specVersion: 8,
    events: {},
    createQueueHandler: () => async () => new Response(null, { status: 204 }),
    getDeploymentId: async () => "probe-deployment",
    async start() {},
    async close() {
      record("started");
      await new Promise((resolve) => setTimeout(resolve, ${CLOSE_DELAY_MS}));
      record("finished");
    },
  };
}
`;

describe("production server shutdown", () => {
  const scenarioApp = useScenarioApp();

  it("waits for the configured Workflow World to close before exiting on SIGTERM", async () => {
    const { appRoot } = await scenarioApp({
      name: "server-shutdown-world-close",
      installDependencies: true,
      dependencies: { "probe-world": "file:./probe-world" },
      files: {
        "agent/agent.ts": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  experimental: { workflow: { world: "probe-world" } },',
          "};",
        ].join("\n"),
        "agent/instructions.md": "Answer briefly.",
        "probe-world/package.json": JSON.stringify({
          name: "probe-world",
          version: "0.0.0",
          type: "module",
          exports: "./index.js",
        }),
        "probe-world/index.js": PROBE_WORLD_SOURCE,
      },
    });
    await buildApplication(appRoot, { skipSandboxPrewarm: true });

    const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
    try {
      expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
    } finally {
      // Sends SIGTERM and resolves once the server process has exited.
      await server.close();
    }

    const phases = (await readFile(join(appRoot, "world-close.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    expect(phases).toEqual(["started", "finished"]);
  });
});
