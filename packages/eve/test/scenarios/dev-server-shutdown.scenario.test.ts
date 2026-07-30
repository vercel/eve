import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import type { RunningEveDev } from "./dev-server-harness.js";
import {
  forceDevelopmentRebuild,
  signalEveDevDuringStartup,
  startEveDev,
  waitForCondition,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const WORKFLOW_SHUTDOWN_DESCRIPTOR = {
  files: {
    "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
    "agent/instrumentation.mjs": 'globalThis.__EVE_SHUTDOWN_PROBE__ = "one";\nexport default {};\n',
    "agent/instructions.md": "Exercise development worker shutdown.\n",
  },
  installDependencies: true,
  name: "dev-workflow-shutdown",
} as const;

interface WorkflowShutdownProbe {
  readonly appRoot: string;
  readonly eventsPath: string;
  readonly lockDirectoryPath: string;
}

async function createWorkflowShutdownProbe(): Promise<WorkflowShutdownProbe> {
  const app = await scenarioApp(WORKFLOW_SHUTDOWN_DESCRIPTOR);
  const eventsPath = join(app.appRoot, "workflow-world-events.log");
  const lockDirectoryPath = join(app.appRoot, "workflow-world-locks");
  const workflowWorldPath = join(app.appRoot, "workflow-shutdown-world.mjs");

  await writeFile(
    join(app.appRoot, "agent", "agent.mjs"),
    [
      "export default {",
      '  model: "openai/gpt-5.4",',
      "  experimental: {",
      `    workflow: { world: ${JSON.stringify(workflowWorldPath)} },`,
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    workflowWorldPath,
    [
      'import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import { threadId } from "node:worker_threads";',
      "",
      `const eventsPath = ${JSON.stringify(eventsPath)};`,
      `const lockDirectoryPath = ${JSON.stringify(lockDirectoryPath)};`,
      "const instanceId = `${process.pid}:${threadId}`;",
      "const instanceLockPath = join(lockDirectoryPath, `${process.pid}-${threadId}.lock`);",
      "",
      "export function createWorld() {",
      "  return {",
      "    specVersion: 5,",
      "    events: {},",
      "    createQueueHandler() {",
      "      return async () => Response.json({ ok: true });",
      "    },",
      "    async start() {",
      "      await mkdir(lockDirectoryPath, { recursive: true });",
      "      const existingLocks = await readdir(lockDirectoryPath);",
      "      const foreignLock = existingLocks.find(",
      "        (name) => !name.startsWith(`${process.pid}-`),",
      "      );",
      "      if (foreignLock !== undefined) {",
      "        throw new Error(`Workflow world lock is still held by ${foreignLock}.`);",
      "      }",
      '      await writeFile(instanceLockPath, "locked", { flag: "wx" });',
      "      await appendFile(eventsPath, `start:${instanceId}\\n`);",
      "    },",
      "    async close() {",
      "      await appendFile(eventsPath, `close:${instanceId}\\n`);",
      "      await rm(instanceLockPath);",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    appRoot: app.appRoot,
    eventsPath,
    lockDirectoryPath,
  };
}

async function readEventLines(eventsPath: string): Promise<string[]> {
  try {
    return (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("eve dev shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`returns within one second after ${signal}`, async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      const exit = await server.signalAndAwaitExit(signal);

      expect(exit.forcedKill).toBe(false);
      expect(exit.durationMs).toBeLessThan(1_000);
      expect(exit.code).toBe(0);
      expect(exit.signal).toBe(null);
      await expect(fetch(server.url)).rejects.toThrow();
    }, 120_000);
  }

  it("returns within one second when signalled during startup", async () => {
    const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const exit = await signalEveDevDuringStartup(app.appRoot, "SIGTERM");

    expect(exit.forcedKill).toBe(false);
    expect(exit.durationMs).toBeLessThan(1_000);
  }, 120_000);

  it("closes configured Workflow worlds on reload and before an immediate restart", async () => {
    const probe = await createWorkflowShutdownProbe();
    let firstServer: RunningEveDev | undefined;
    let secondServer: RunningEveDev | undefined;

    try {
      firstServer = await startEveDev(probe.appRoot);
      await waitForCondition(
        async () =>
          (await readEventLines(probe.eventsPath)).filter((line) => line.startsWith("start:"))
            .length === 1,
        "Timed out waiting for the first Workflow world to start.",
      );

      await writeFile(
        join(probe.appRoot, "agent", "instrumentation.mjs"),
        'globalThis.__EVE_SHUTDOWN_PROBE__ = "two";\nexport default {};\n',
        "utf8",
      );
      await forceDevelopmentRebuild(firstServer.url);
      await waitForCondition(async () => {
        const events = await readEventLines(probe.eventsPath);
        return (
          events.filter((line) => line.startsWith("start:")).length >= 2 &&
          events.some((line) => line.startsWith("close:"))
        );
      }, "Timed out waiting for the retired development worker to close its Workflow world.");

      const firstExit = await firstServer.signalAndAwaitExit("SIGTERM");
      expect(firstExit.forcedKill).toBe(false);
      expect(firstExit.durationMs).toBeLessThan(1_000);
      expect(firstExit.code).toBe(0);
      expect(await readdir(probe.lockDirectoryPath)).toEqual([]);

      secondServer = await startEveDev(probe.appRoot);
      await waitForCondition(
        async () =>
          (await readEventLines(probe.eventsPath)).filter((line) => line.startsWith("start:"))
            .length >= 3,
        "Timed out waiting for the immediate restart to acquire its Workflow world lock.",
      );

      const secondExit = await secondServer.signalAndAwaitExit("SIGTERM");
      expect(secondExit.forcedKill).toBe(false);
      expect(secondExit.durationMs).toBeLessThan(1_000);
      expect(secondExit.code).toBe(0);
      expect(await readdir(probe.lockDirectoryPath)).toEqual([]);

      const events = await readEventLines(probe.eventsPath);
      const starts = events
        .filter((line) => line.startsWith("start:"))
        .map((line) => line.slice("start:".length));
      const closes = events
        .filter((line) => line.startsWith("close:"))
        .map((line) => line.slice("close:".length));

      expect(starts.length).toBeGreaterThanOrEqual(3);
      expect(closes.sort()).toEqual(starts.sort());
    } finally {
      await firstServer?.stop();
      await secondServer?.stop();
    }
  }, 120_000);
});
