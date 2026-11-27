import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import {
  startEveDev,
  waitForCondition,
  type RunningEveDev,
} from "#internal/testing/dev-server-harness.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";

const scenarioApp = useScenarioApp();
const MINUTE_WAIT_MS = 100_000;

const appDescriptor = {
  name: "local-dev-schedules",
  dependencies: { zod: "4.5.4" },
  installDependencies: true,
  files: {
    "agent/instructions.md": "Arm the wake schedule when asked.\n",
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(({ toolResults }) =>
    toolResults.length > 0
      ? { text: "armed" }
      : { toolCalls: [{ name: "schedule__wake__create", input: {
          name: "every-minute",
          expression: { type: "cron", cron: "* * * * *" },
          payload: { note: "wake" },
        } }] },
  ),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/schedules/wake.ts": `import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { byPrincipal, defineDynamicSchedules } from "eve/schedules";
export default defineDynamicSchedules({
  inputSchema: z.object({ note: z.string() }),
  scope: byPrincipal,
  tool: true,
  approval: { create: () => "not-applicable" },
  auth: ({ principal }) => ({ attributes: {}, authenticator: principal.authenticator,
    principalId: principal.principalId, principalType: principal.type }),
  async run({ occurrence }) {
    await appendFile(join(process.env.EVE_DEV_WORKER_APP_ROOT!, "occurrences.jsonl"),
      JSON.stringify({ scheduledAt: occurrence.scheduledAt }) + "\\n");
  },
});
`,
  },
};

const standaloneEnv = {
  NODE_ENV: "development",
  VERCEL_DEPLOYMENT_ID: undefined,
  VERCEL_SCHEDULE_DEV_API_VERSION: undefined,
  VERCEL_SCHEDULE_BASE_URL: undefined,
  VERCEL_QUEUE_BASE_URL: undefined,
};

async function readScheduledAt(appRoot: string): Promise<string[]> {
  try {
    return (await readFile(join(appRoot, "occurrences.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { scheduledAt: string }).scheduledAt);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("standalone eve dev dynamic schedules", () => {
  it(
    "fires a schedule on its own and keeps firing it after the dev server crashes and resumes",
    async () => {
      const app = await scenarioApp(appDescriptor);
      let server: RunningEveDev | undefined;
      try {
        server = await startEveDev(app.appRoot, { env: standaloneEnv });
        const created = await new Client({ baseUrl: server.url }).sessions.create({
          message: "Arm the wake schedule.",
        });
        await expect(created.delivery.result()).resolves.toMatchObject({ status: "completed" });

        await waitForCondition(
          async () => (await readScheduledAt(app.appRoot)).length >= 1,
          () => `The schedule never fired on its own.\n${server?.stderr()}`,
          MINUTE_WAIT_MS,
        );
        const firedBeforeCrash = await readScheduledAt(app.appRoot);

        await server.crash();
        server = await startEveDev(app.appRoot, { env: standaloneEnv, resume: true });
        await waitForCondition(
          async () => (await readScheduledAt(app.appRoot)).length > firedBeforeCrash.length,
          () =>
            `The schedule did not fire again after the dev server resumed.\n${server?.stderr()}`,
          MINUTE_WAIT_MS,
        );
        const fired = await readScheduledAt(app.appRoot);
        expect(new Set(fired).size).toBe(fired.length);
      } finally {
        await server?.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
