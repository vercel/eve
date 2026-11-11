import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { returnAskAnswerWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";
import {
  type WorkflowExecuteToolDefinition,
  defineWorkflowTool,
} from "#tools/workflow-definition.js";

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

type Stage = Awaited<ReturnType<ReturnType<typeof captureTurnEvents>["nextTurn"]>>;

/**
 * Starts a session whose agent has `read_notes` and a `confirm_deploy` workflow tool, which asks
 * before it returns and is offered only while `isEnabled()` says so. The scripted model calls
 * `confirm_deploy` when the latest message names it and the call offers it, and records the tools
 * each call offered.
 */
async function withEnabledRun(
  name: string,
  isEnabled: () => boolean,
  body: (run: {
    readonly offered: string[][];
    readonly answer: (stage: Stage) => Promise<Stage>;
    readonly send: (message: string) => Promise<Stage>;
    readonly first: Stage;
  }) => Promise<void>,
) {
  const offered: string[][] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const names = (tools ?? []).map((tool) => tool.name);
        offered.push(names);
        const latest = prompt.at(-1);
        const asksForDeploy =
          latest?.role === "user" && JSON.stringify(latest.content).includes("confirm_deploy");
        return asksForDeploy && names.includes("confirm_deploy")
          ? toolCallStreamResult({
              input: JSON.stringify({ service: "api" }),
              toolCallId: `call-${offered.length}`,
              toolName: "confirm_deploy",
            })
          : textStreamResult("Done.");
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        logicalPath: "tools/confirm_deploy.ts",
        loadNamespace: async () => ({
          default: defineWorkflowTool({
            description: "Deploy a service once someone confirms.",
            enabled: () => isEnabled(),
            execute: returnAskAnswerWorkflow as WorkflowExecuteToolDefinition["execute"],
            inputSchema: {
              additionalProperties: false,
              properties: { service: { type: "string" } },
              required: ["service"],
              type: "object",
            },
          }),
        }),
      },
      {
        logicalPath: "tools/read_notes.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Read the release notes.",
            execute: () => "No notes.",
            inputSchema: {},
          }),
        }),
      },
    ],
  });
  const continuationToken = `http:${name}`;

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Use confirm_deploy for the api service." },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    const delivery = createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" });
    try {
      await body({
        offered,
        first: await withTimeout(stream.nextTurn(), "first turn"),
        async answer(stage) {
          const question = filterEventsByType(stage, "interaction.opened").find(
            (event) => event.data.request.kind === "question",
          );
          expect(question).toBeDefined();
          await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
            auth: ALICE,
            kind: "send",
            delivery,
            payload: {
              answers: [{ interactionId: question!.data.interactionId, optionId: "approve" }],
            },
          });
          return await withTimeout(stream.nextTurn(), "answered");
        },
        async send(message) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth: ALICE,
            kind: "send",
            delivery,
            payload: { message },
          });
          return await withTimeout(stream.nextTurn(), "message");
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
}

function questionsIn(stage: Stage) {
  return filterEventsByType(stage, "interaction.opened").filter(
    (event) => event.data.request.kind === "question",
  );
}

describe("enabled tools", () => {
  it("offers a workflow tool only on the calls its enabled allows", async () => {
    let enabled = false;
    await withEnabledRun(
      "tool-enabled-offer",
      () => enabled,
      async ({ first, offered, send }) => {
        expect(offered.at(-1)).toContain("read_notes");
        expect(offered.at(-1)).not.toContain("confirm_deploy");
        expect(questionsIn(first)).toHaveLength(0);

        enabled = true;
        const second = await send("Use confirm_deploy for the api service.");

        expect(offered.at(-1)).toContain("confirm_deploy");
        expect(questionsIn(second)).toHaveLength(1);
      },
    );
  }, 60_000);

  it("finishes a waiting call after its tool is disabled", async () => {
    let enabled = true;
    await withEnabledRun(
      "tool-enabled-waiting",
      () => enabled,
      async ({ answer, first, offered }) => {
        expect(questionsIn(first)).toHaveLength(1);

        enabled = false;
        const answered = await answer(first);

        expect(filterEventsByType(answered, "call.settled")).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: "completed",
              output: expect.objectContaining({ optionId: "approve", status: "answered" }),
            }),
          }),
        );
        expect(filterEventsByType(answered, "turn.settled").at(-1)?.data.outcome).toBe("completed");
        expect(offered.at(-1)).not.toContain("confirm_deploy");
      },
    );
  }, 60_000);
});
