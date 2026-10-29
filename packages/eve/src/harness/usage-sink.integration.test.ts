import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { recordUsage } from "#harness/usage-sink.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import {
  defineDynamic as defineDynamicInstructions,
  defineInstructions,
} from "#public/definitions/instructions.js";
import { defineDynamic } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";

// Model calls a session's own code makes, outside eve's model steps, count as the session's usage.

describe("usage a session's code records", () => {
  it("counts against the tool call that spent it, and ownerless from a dynamic value", async () => {
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options: LanguageModelV4CallOptions) =>
          options.prompt.at(-1)?.role === "tool"
            ? textStreamResult("Summarized.")
            : toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "summarize" }),
        modelId: "gpt-5.5",
        provider: "openai",
      }),
    );
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "usage-sink",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Summarize Alice's notes with a model of its own.",
              execute: async () => {
                await recordUsage({ inputTokens: 40, outputTokens: 8 });
                return { summary: "Two notes." };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/summarize.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamicInstructions(async () => {
              await recordUsage({ inputTokens: 5, outputTokens: 1 });
              return defineInstructions({ content: "Be brief." });
            }),
          }),
          logicalPath: "instructions/brief.ts",
        },
      ],
    });
    const events = await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          input: { message: "Summarize my notes." },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: `http:usage-sink-${Math.random()}`,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        return await withTimeout(stream.nextTurn(), "turn");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    const auxiliary = filterEventsByType(events, "usage.recorded").filter(
      (event) => event.data.kind === "auxiliary",
    );
    expect(auxiliary).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          owner: { callId: "call-1" },
          usage: expect.objectContaining({ inputTokens: 40, outputTokens: 8 }),
        }),
      }),
    );
    expect(auxiliary).toContainEqual(
      expect.objectContaining({
        data: { kind: "auxiliary", usage: expect.objectContaining({ inputTokens: 5 }) },
      }),
    );
  });
});
