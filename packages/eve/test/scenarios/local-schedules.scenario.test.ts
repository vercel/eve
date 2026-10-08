import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { fetchAgentInfo, startEveDev, waitForCondition } from "./dev-server-harness.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";

const scenarioApp = useScenarioApp();

afterEach(() => vi.unstubAllEnvs());

describe("local Vercel schedule delivery", () => {
  it(
    "consumes and acknowledges a broker occurrence through the authored collection",
    async () => {
      const app = await scenarioApp({
        name: "local-schedules",
        dependencies: { zod: "4.5.4" },
        installDependencies: true,
        files: {
          "agent/instructions.md": "Help Alice review her daily reports.\n",
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
          "agent/schedules/requests.ts": `import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineDynamicSchedules } from "eve/experimental/schedules";

export default defineDynamicSchedules({
  inputSchema: z.object({ task: z.string() }),
  tool: false,
  auth: ({ principal }) => ({
    attributes: {},
    authenticator: principal.authenticator,
    principalId: principal.principalId,
    principalType: principal.type,
  }),
  async run({ payload, auth }) {
    await appendFile(join(process.env.EVE_DEV_WORKER_APP_ROOT!, "occurrences.jsonl"),
      JSON.stringify({ task: payload.task, creator: auth.principalId }) + "\\n");
  },
});
`,
        },
      });
      let stored: Record<string, unknown> | undefined;
      let pending: unknown;
      let acknowledged = false;
      const broker = createServer(async (request, response) => {
        if (request.headers.authorization !== "Bearer local-token") {
          response.writeHead(401).end();
          return;
        }
        const url = new URL(request.url!, "http://localhost");
        if (url.pathname === "/v1/schedules" && request.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          stored = {
            ...JSON.parse(Buffer.concat(chunks).toString()),
            scheduleId: "sch_local",
            source: "dynamic",
            state: "active",
            createdAt: 1,
            updatedAt: 1,
          };
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(stored));
        } else if (url.pathname === "/v1/schedules/alice-reminder") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(stored));
        } else if (url.pathname.startsWith("/api/v3/topic/") && request.method === "DELETE") {
          acknowledged = true;
          response.writeHead(204).end();
        } else if (url.pathname.startsWith("/api/v3/topic/") && request.method === "POST") {
          if (pending === undefined) {
            response.writeHead(204).end();
            return;
          }
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
              JSON.stringify(pending),
              "--local-message--",
              "",
            ].join("\r\n"),
          );
          pending = undefined;
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
      const address = broker.address();
      if (!address || typeof address === "string") throw new Error("Missing broker address.");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const env = {
        NODE_ENV: "development",
        VERCEL_DEPLOYMENT_ID: undefined,
        VERCEL_SCHEDULE_DEV_API_VERSION: "1",
        VERCEL_SCHEDULE_BASE_URL: endpoint,
        VERCEL_SCHEDULE_TOKEN: "local-token",
        VERCEL_QUEUE_BASE_URL: endpoint,
        VERCEL_QUEUE_TOKEN: "local-token",
      };
      try {
        const server = await startEveDev(app.appRoot, { env });
        try {
          const application = (await fetchAgentInfo(server.url)).agent.name;
          for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
          vi.stubEnv("EVE_DEV", "1");
          const provider = vercelScheduleProvider();
          const record = await provider.create(
            {
              abortSignal: new AbortController().signal,
              collection: "requests",
              namespace: "eve-local-schedules",
              operationId: "create-reminder",
              target: { key: application },
            },
            {
              name: "alice-reminder",
              expression: { type: "cron", cron: "* * * * *", timezone: "UTC" },
              payload: createScheduleCollectionPayload({
                application,
                collection: "requests",
                envelope: {
                  version: 3,
                  scope: "alice",
                  principal: { type: "user", authenticator: "fixture", principalId: "alice" },
                  payload: { task: "Review the daily report" },
                },
              }),
            },
          );
          pending = {
            scheduleId: record.scheduleId,
            name: record.name,
            namespace: "eve-local-schedules",
            executionId: "schx_local",
            scheduledAt: "2026-10-08T12:00:00.000Z",
            source: "dynamic",
            payload: stored!.payload,
          };
          const occurrencesPath = join(app.appRoot, "occurrences.jsonl");
          await waitForCondition(
            () => existsSync(occurrencesPath) && acknowledged,
            () => `Local occurrence was not dispatched and acknowledged.\n${server.stderr()}`,
          );
          expect(JSON.parse((await readFile(occurrencesPath, "utf8")).trim())).toEqual({
            task: "Review the daily report",
            creator: "alice",
          });
        } finally {
          await server.stop();
        }
      } finally {
        broker.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          broker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
