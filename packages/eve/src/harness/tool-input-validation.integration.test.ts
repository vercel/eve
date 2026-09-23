import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

function findToolResult(messages: readonly ModelMessage[], toolCallId: string): unknown {
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const result = message.content.find(
      (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

describe("framework tool input validation (real AI SDK)", () => {
  it("rejects invalid final_output input instead of terminating the task", async () => {
    const invalidCallId = "final-invalid";
    const validCallId = "final-valid";
    const outputSchema = {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ answer: 42 }),
              toolCallId: invalidCallId,
              toolName: "final_output",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ answer: "done" }),
              toolCallId: validCallId,
              toolName: "final_output",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
      modelId: "final-output-validation-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "task",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "final-output-validation-model" },
        system: "Return structured output.",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "task:final-output-validation-session",
      history: [],
      outputSchema,
      sessionId: "final-output-validation-session",
    };
    const runStep = createToolLoopHarness(config);

    const invalidStep = await runStep(session, { message: "Finish the task." });

    expect(typeof invalidStep.next).toBe("function");
    expect(findToolResult(invalidStep.session.history, invalidCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "final_output",
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected invalid final output to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(validStep.next).toEqual({ done: true, output: { answer: "done" } });
  });
});
