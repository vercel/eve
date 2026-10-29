import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#public/definitions/model.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { turnInputText } from "./turn.js";

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

it("keeps a turn's input for its dynamic values after the turn pauses for an approval", async () => {
  const seen: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (options) =>
        options.prompt.at(-1)?.role === "tool"
          ? textStreamResult("Released 1.2.")
          : toolCallStreamResult({
              input: '{"version":"1.2"}',
              toolCallId: "call-1",
              toolName: "release",
            }),
      modelId: "gpt-5.5",
      provider: "openai",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        // Evaluated before each model call: before the approval, and after it.
        model: defineDynamic((ctx) => {
          seen.push(ctx.turn === null ? "(no turn)" : turnInputText(ctx.turn));
          return { model, modelContextWindowTokens: 200_000 };
        }),
      }),
      name: "turn-input",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            approval: { request: always(), response: () => ({ status: "allowed" }) },
            description: "Release a version.",
            execute: async () => ({ released: true }),
            inputSchema: {
              properties: { version: { type: "string" } },
              required: ["version"],
              type: "object",
            },
          }),
        }),
        logicalPath: "tools/release.ts",
      },
    ],
  });

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        input: { message: "Release version 1.2 for Alice." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: {
          ...buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: "http:turn-input",
          }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    try {
      const paused = await withTimeout(stream.nextTurn(), "approval");
      const [opened] = filterEventsByType(paused, "interaction.opened");
      await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
        auth: ALICE,
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        kind: "send",
        payload: { answers: [{ interactionId: opened!.data.interactionId, optionId: "approve" }] },
      });
      await withTimeout(stream.nextTurn(), "approved");
    } finally {
      stream.dispose();
      await run.cancel();
    }
  });

  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seen)).toEqual(new Set(["Release version 1.2 for Alice."]));
});
