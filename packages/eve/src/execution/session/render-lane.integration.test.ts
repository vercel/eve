import { afterEach, describe, expect, it, vi } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { toInputSchema, serializeInputSchema } from "#tools/schema.js";
import { defineWorkflowTool, type WorkflowTaskToolDefinition } from "#tools/workflow-definition.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session render lane", () => {
  it("writes a turn's task card outside the turn, once, through to its finished state", async () => {
    const cardWrites: { readonly body: Record<string, unknown>; readonly operation: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "slack.com") return realFetch(input, init);
      const operation = url.pathname.split("/").at(-1)!;
      const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
      const body = decodeSlackApiBody(init?.body ?? "", contentType) as Record<string, unknown>;
      if (/"type":"(task_card|plan)"/.test(JSON.stringify(body["blocks"]))) {
        cardWrites.push({ body, operation });
      }
      return Response.json({ ok: true, ts: `1700000009.${String(cardWrites.length)}` });
    });
    const runtime = await createTestRuntime({
      agent: { name: "render-lane-task-card" },
      modules: [
        {
          logicalPath: "channels/slack.ts",
          loadNamespace: async () => ({
            default: slackChannel({ credentials: { botToken: "xoxb-test" } }),
          }),
        },
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Deploys a service.",
              task: deployServiceWorkflow as WorkflowTaskToolDefinition["task"],
              inputSchema:
                serializeInputSchema(
                  toInputSchema({
                    additionalProperties: false,
                    properties: { service: { type: "string" } },
                    required: ["service"],
                    type: "object",
                  }),
                ) ?? {},
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({ continuationToken: "slack:render-lane" }),
            "eve.channel": {
              kind: "channel:slack",
              state: { audience: "private", channelId: "C01", threadTs: "1700000000.000001" },
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const turn = await stream.nextTurn();
        expect(filterEventsByType(turn, "task.settled")).toHaveLength(1);

        await vi.waitFor(
          () =>
            expect(cardWrites.at(-1)?.body["blocks"]).toMatchObject([
              { status: "complete", type: "task_card" },
            ]),
          { timeout: 15_000 },
        );
        const posts = cardWrites.filter((write) => write.operation === "chat.postMessage");
        expect(posts).toHaveLength(1);
        expect(
          cardWrites
            .filter((write) => write.operation === "chat.update")
            .every((write) => write.body["ts"] === "1700000009.1"),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
