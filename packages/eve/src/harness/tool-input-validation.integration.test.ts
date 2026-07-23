import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { getPendingInputRequestIds } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  ASK_QUESTION_INPUT_SCHEMA,
  ASK_QUESTION_TOOL_DEFINITION,
} from "#runtime/framework-tools/ask-question.js";
import { serializeInputSchema } from "#shared/tool-schema.js";

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
  it("returns malformed and schema-invalid ask_question input to the model before accepting a retry", async () => {
    const malformedCallId = "question-malformed";
    const invalidCallId = "question-invalid";
    const validCallId = "question-valid";
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: '{"prompt":',
              toolCallId: malformedCallId,
              toolName: "ask_question",
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
              input: JSON.stringify({ prompt: 42 }),
              toolCallId: invalidCallId,
              toolName: "ask_question",
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
              input: JSON.stringify({ prompt: "Which option should I use?" }),
              toolCallId: validCallId,
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
      modelId: "tool-validation-model",
      provider: "eve-integration-mock",
    });
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "ask_question",
        {
          description: ASK_QUESTION_TOOL_DEFINITION.description,
          inputSchema: ASK_QUESTION_INPUT_SCHEMA,
          name: "ask_question",
        },
      ],
    ]);
    const config: ToolLoopHarnessConfig = {
      capabilities: { requestInput: true },
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools,
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "tool-validation-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: ASK_QUESTION_TOOL_DEFINITION.description,
            inputSchema: serializeInputSchema(ASK_QUESTION_INPUT_SCHEMA),
            name: "ask_question",
          },
        ],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:tool-validation-session",
      history: [],
      sessionId: "tool-validation-session",
    };
    const runStep = createToolLoopHarness(config);

    const malformedStep = await runStep(session, { message: "Ask me which option to use." });

    expect(typeof malformedStep.next).toBe("function");
    expect(getPendingInputRequestIds(malformedStep.session.state)).toEqual(new Set());
    expect(findToolResult(malformedStep.session.history, malformedCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "ask_question",
    });

    if (typeof malformedStep.next !== "function") {
      throw new TypeError("Expected the malformed tool call to continue the tool loop.");
    }
    const invalidStep = await malformedStep.next(malformedStep.session);

    expect(typeof invalidStep.next).toBe("function");
    expect(getPendingInputRequestIds(invalidStep.session.state)).toEqual(new Set());
    expect(findToolResult(invalidStep.session.history, invalidCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "ask_question",
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected the invalid tool call to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doGenerateCalls).toHaveLength(3);
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [], malformedCallId)).toBeDefined();
    expect(findToolResult(model.doGenerateCalls[2]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(validStep.next).toBeNull();
    expect(getPendingInputRequestIds(validStep.session.state)).toEqual(new Set([validCallId]));
  });

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
