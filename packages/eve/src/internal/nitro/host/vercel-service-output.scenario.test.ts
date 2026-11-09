import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";
import { buildApplication } from "#internal/nitro/host.js";
import { EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH } from "#internal/schedules/consumer-route.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/flow-route.js";
import { deriveEveWorkflowQueueTopic } from "#internal/workflow/queue-namespace.js";

const createAppRoot = useTemporaryAppRoots();
const AGENT_NAME = "service-output-agent";

describe("Vercel service build output", () => {
  it("keeps each queue consumer's own function, trigger, and route", async () => {
    const { appRoot } = await createAppRoot("eve-vercel-service-output-", {
      packageName: AGENT_NAME,
      files: {
        "agent/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n`,
        "agent/instructions.md": "Keep reminders.\n",
        "agent/schedules/reminders.ts": [
          'import { defineDynamicSchedules } from "eve/experimental/schedules";',
          "const anyInput = { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } };",
          "export default defineDynamicSchedules({",
          "  inputSchema: anyInput,",
          "  tool: false,",
          "  auth: ({ principal }) => ({ attributes: {}, authenticator: principal.authenticator,",
          "    principalId: principal.principalId, principalType: principal.type }),",
          "  async run() {},",
          "});",
          "",
        ].join("\n"),
        "vercel.json": JSON.stringify({
          experimentalServices: {
            eve: { entrypoint: ".", framework: "eve", routePrefix: "/_eve_internal/eve" },
            web: { entrypoint: ".", framework: "nuxtjs", routePrefix: "/" },
          },
        }),
      },
    });

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: true });
    const config = JSON.parse(await readFile(join(outputDir, "config.json"), "utf8")) as {
      readonly routes: readonly { readonly dest?: string }[];
    };

    for (const [route, topic] of [
      [EVE_WORKFLOW_FLOW_ROUTE_PATH, deriveEveWorkflowQueueTopic(AGENT_NAME)],
      [EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH, deriveEveScheduleQueueTopic(AGENT_NAME)],
    ] as const) {
      const functionConfig = JSON.parse(
        await readFile(
          join(outputDir, "functions", `${route.slice(1)}.func`, ".vc-config.json"),
          "utf8",
        ),
      ) as { readonly experimentalTriggers?: readonly { readonly topic?: string }[] };
      expect(functionConfig.experimentalTriggers).toEqual([expect.objectContaining({ topic })]);
      expect(config.routes).toContainEqual(expect.objectContaining({ dest: route }));
    }
  });
});
