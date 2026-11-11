import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

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
import {
  returnAskAnswerWorkflow,
  waitingForCleanupWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";
import { type DynamicToolEntry, defineDynamic } from "#tools/dynamic.js";
import {
  type WorkflowExecuteToolDefinition,
  type WorkflowTaskToolDefinition,
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

const DEPLOY_INPUT = {
  additionalProperties: false,
  properties: { service: { type: "string" } },
  required: ["service"],
  type: "object",
} as const;

// A task that keeps running after the turn that started it.
const holdDeploy = defineWorkflowTool({
  description: "Start a deploy that keeps running in the background.",
  inputSchema: DEPLOY_INPUT,
  task: waitingForCleanupWorkflow as unknown as WorkflowTaskToolDefinition["task"],
});

// Declared outside the dynamic function, so the same compiled workflow backs every evaluation.
const confirmDeploy = defineWorkflowTool({
  description: "Deploy a service once someone confirms.",
  execute: returnAskAnswerWorkflow as WorkflowExecuteToolDefinition["execute"],
  inputSchema: DEPLOY_INPUT,
});

/**
 * Starts a session whose agent has a static `read_notes` tool and a `defineDynamic()` that
 * returns the `confirm_deploy` workflow tool while `isOffered()` says so. The scripted model
 * calls `confirm_deploy` when the latest message names it and the call offers it, and records
 * the tools each call offered.
 */
async function withDynamicRun(
  name: string,
  isOffered: () => boolean,
  tool: DynamicToolEntry,
  body: (run: {
    readonly offered: string[][];
    readonly answer: (stage: Stage) => Promise<Stage>;
    readonly send: (message: string) => Promise<Stage>;
    readonly first: () => Promise<Stage>;
    /** Delivers a message without waiting for a turn to settle, as steering joins an open one. */
    readonly deliver: (message: string) => Promise<void>;
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
        // Without the default `agent` tool, only the dynamic tool can start tasks.
        defaultTools: false,
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        logicalPath: "tools/support.ts",
        loadNamespace: async () => ({
          default: defineDynamic(() => (isOffered() ? { confirm_deploy: tool } : null)),
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
        first: () => withTimeout(stream.nextTurn(), "first turn"),
        async deliver(message) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth: ALICE,
            kind: "send",
            delivery,
            payload: { message },
          });
        },
        async answer(stage) {
          const question = questionsIn(stage)[0];
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

function answeredCall(stage: Stage) {
  return filterEventsByType(stage, "call.settled").find(
    (event) => event.data.outcome === "completed" && event.data.output !== undefined,
  );
}

describe("dynamic workflow tools", () => {
  it("offers a workflow tool only while its defineDynamic() returns it, and runs it as a workflow", async () => {
    let offeredNow = false;
    await withDynamicRun(
      "dynamic-workflow-offer",
      () => offeredNow,
      confirmDeploy,
      async ({ answer, first: settled, offered, send }) => {
        const first = await settled();
        expect(offered.at(-1)).toContain("read_notes");
        expect(offered.at(-1)).not.toContain("confirm_deploy");
        expect(questionsIn(first)).toHaveLength(0);

        offeredNow = true;
        const second = await send("Use confirm_deploy for the api service.");
        expect(offered.at(-1)).toContain("confirm_deploy");
        expect(questionsIn(second)).toHaveLength(1);

        const answered = await answer(second);
        expect(answeredCall(answered)?.data).toMatchObject({
          output: expect.objectContaining({ optionId: "approve", status: "answered" }),
        });
        expect(filterEventsByType(answered, "turn.settled").at(-1)?.data.outcome).toBe("completed");
      },
    );
  }, 60_000);

  it("finishes a waiting call after its defineDynamic() stops returning the tool", async () => {
    let offeredNow = true;
    await withDynamicRun(
      "dynamic-workflow-withdrawn",
      () => offeredNow,
      confirmDeploy,
      async ({ answer, first: settled, offered }) => {
        const first = await settled();
        expect(questionsIn(first)).toHaveLength(1);

        offeredNow = false;
        const answered = await answer(first);

        expect(answeredCall(answered)?.data).toMatchObject({
          output: expect.objectContaining({ optionId: "approve", status: "answered" }),
        });
        expect(filterEventsByType(answered, "turn.settled").at(-1)?.data.outcome).toBe("completed");
        expect(offered.at(-1)).not.toContain("confirm_deploy");
      },
    );
  }, 60_000);

  it("keeps the task tools while a task started by a withdrawn tool still runs", async () => {
    let offeredNow = true;
    await withDynamicRun(
      "dynamic-workflow-task-withdrawn",
      () => offeredNow,
      holdDeploy,
      async ({ deliver, offered }) => {
        // The turn stays open while its task runs, so wait for the call after the task started.
        await vi.waitFor(() => expect(offered.length).toBeGreaterThanOrEqual(2), {
          timeout: 20_000,
        });
        expect(offered.at(-1)).toContain("eve__task_wait");

        offeredNow = false;
        const calls = offered.length;
        await deliver("How is it going?");
        await vi.waitFor(() => expect(offered.length).toBeGreaterThan(calls), { timeout: 20_000 });

        expect(offered.at(-1)).not.toContain("confirm_deploy");
        expect(offered.at(-1)).toEqual(
          expect.arrayContaining(["eve__task_wait", "eve__task_cancel"]),
        );
      },
    );
  }, 60_000);
});
