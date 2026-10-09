import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";
import {
  fetchAgentInfo,
  startEveDev,
  waitForCondition,
  type RunningEveDev,
} from "./dev-server-harness.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";

const scenarioApp = useScenarioApp();
const appDescriptor = {
  name: "local-schedules",
  dependencies: { zod: "4.5.4" },
  installDependencies: true,
  files: {
    "agent/instructions.md": "Help Alice review her daily reports.\n",
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
    "agent/schedules/heartbeat.ts": 'export default { cron: "* * * * *", run() {} };\n',
  },
};
const localEnv = {
  NODE_ENV: "development",
  VERCEL_DEPLOYMENT_ID: undefined,
  VERCEL_SCHEDULE_DEV_API_VERSION: "1",
};
const collectionSource = `import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineDynamicSchedules } from "eve/experimental/schedules";
export default defineDynamicSchedules({
  inputSchema: z.object({ task: z.string() }),
  tool: false,
  auth: ({ principal }) => ({ attributes: {}, authenticator: principal.authenticator,
    principalId: principal.principalId, principalType: principal.type }),
  async run({ payload, auth }) {
    await appendFile(join(process.env.EVE_DEV_WORKER_APP_ROOT!, "occurrences.jsonl"),
      JSON.stringify({ task: payload.task, creator: auth.principalId }) + "\\n");
  },
});
`;

describe("local Vercel schedule delivery", () => {
  it(
    "boots a static-only agent without local queue configuration",
    async () => {
      const app = await scenarioApp(appDescriptor);
      const server = await startEveDev(app.appRoot, {
        env: { ...localEnv, VERCEL_QUEUE_BASE_URL: undefined, VERCEL_QUEUE_TOKEN: undefined },
      });
      try {
        expect((await fetchAgentInfo(server.url)).agent.name).toBe(appDescriptor.name);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "consumes and acknowledges an occurrence after hot-adding the first dynamic collection",
    async () => {
      const app = await scenarioApp(appDescriptor);
      const topic = deriveEveScheduleQueueTopic(appDescriptor.name);
      const identity = {
        scheduleId: "sch_local",
        name: "alice-reminder",
        namespace: "eve-local-schedules",
        source: "dynamic",
      };
      const message = {
        ...identity,
        executionId: "schx_local",
        scheduledAt: "2026-10-08T12:00:00.000Z",
        payload: {
          eve: { application: appDescriptor.name, collection: "requests", version: 1 },
          payload: createScheduleCollectionPayload({
            application: appDescriptor.name,
            collection: "requests",
            envelope: {
              version: 3,
              scope: "alice",
              principal: { type: "user", authenticator: "fixture", principalId: "alice" },
              payload: { task: "Review the daily report" },
            },
          }),
        },
      };
      let pending = true;
      let acknowledged = false;
      const broker = createServer((request, response) => {
        if (request.headers.authorization !== "Bearer local-token") {
          response.writeHead(401).end();
        } else if (request.url?.startsWith("/v1/schedules/alice-reminder?")) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ...identity, target: { type: "queue", topic } }));
        } else if (!request.url?.startsWith(`/api/v3/topic/${topic}/consumer/`)) {
          response.writeHead(404).end();
        } else if (request.method === "DELETE") {
          acknowledged = true;
          response.writeHead(204).end();
        } else if (pending) {
          pending = false;
          response.setHeader("content-type", "multipart/mixed; boundary=local-message");
          response.end(
            [
              "--local-message",
              "Content-Type: application/json",
              "Vqs-Message-Id: local-occurrence",
              "Vqs-Receipt-Handle: local-receipt",
              "Vqs-Delivery-Count: 1",
              "Vqs-Timestamp: 2026-10-08T12:00:00.000Z",
              "",
              JSON.stringify(message),
              "--local-message--",
              "",
            ].join("\r\n"),
          );
        } else {
          response.writeHead(204).end();
        }
      });
      await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
      const address = broker.address();
      if (!address || typeof address === "string") throw new Error("Missing broker address.");
      const endpoint = `http://127.0.0.1:${address.port}`;
      let server: RunningEveDev | undefined;
      try {
        server = await startEveDev(app.appRoot, {
          env: {
            ...localEnv,
            VERCEL_SCHEDULE_BASE_URL: endpoint,
            VERCEL_SCHEDULE_TOKEN: "local-token",
            VERCEL_QUEUE_BASE_URL: endpoint,
            VERCEL_QUEUE_TOKEN: "local-token",
          },
        });
        await writeFile(join(app.appRoot, "agent/schedules/requests.ts"), collectionSource);
        const occurrencesPath = join(app.appRoot, "occurrences.jsonl");
        await waitForCondition(
          () => existsSync(occurrencesPath) && acknowledged,
          () => `Local occurrence was not dispatched and acknowledged.\n${server?.stderr()}`,
        );
        expect(JSON.parse((await readFile(occurrencesPath, "utf8")).trim())).toEqual({
          task: "Review the daily report",
          creator: "alice",
        });
      } finally {
        await server?.stop();
        broker.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          broker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
