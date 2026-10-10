import { jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** Streams one scripted response per model call, in order. */
function scriptedStreams(responses: readonly (readonly StreamPart[])[]) {
  const queue = [...responses];
  return async () => {
    const parts = queue.shift();
    if (parts === undefined) throw new Error("No scripted response left.");
    return { stream: convertArrayToReadableStream([...parts]) };
  };
}

function toolCall(toolCallId: string, toolName: string, input: string): StreamPart {
  return { input, toolCallId, toolName, type: "tool-call" };
}

function finish(unified: "length" | "stop" | "tool-calls"): StreamPart {
  return { finishReason: { raw: undefined, unified }, type: "finish", usage };
}

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
  it("rejects invalid eve__reply input instead of settling the turn", async () => {
    const invalidCallId = "final-invalid";
    const validCallId = "final-valid";
    const outputSchema = {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;
    const model = new MockLanguageModelV4({
      doStream: scriptedStreams([
        [
          toolCall(invalidCallId, REPLY_TOOL_NAME, JSON.stringify({ answer: 42 })),
          finish("tool-calls"),
        ],
        [
          toolCall(validCallId, REPLY_TOOL_NAME, JSON.stringify({ answer: "done" })),
          finish("tool-calls"),
        ],
      ]),
      modelId: "final-output-validation-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
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
      toolName: REPLY_TOOL_NAME,
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected invalid final output to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(findToolResult(model.doStreamCalls[1]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(validStep.next).toBeNull();
    expect(validStep.settledTurn).toEqual({ output: { answer: "done" } });
  });

  it.each([
    {
      name: "beside a truncated call",
      truncated: [{ input: '{"path": "notes/bob', toolCallId: "read-truncated" }],
    },
    { name: "alone", truncated: [] },
  ])("answers complete tool calls cut short at the output limit $name", async ({ truncated }) => {
    const skippedCallId = "read-skipped";
    const model = new MockLanguageModelV4({
      doStream: scriptedStreams([
        [
          toolCall(skippedCallId, "read_note", JSON.stringify({ path: "notes/alice.md" })),
          ...truncated.map((call) => toolCall(call.toolCallId, "read_note", call.input)),
          finish("length"),
        ],
        [
          { id: "reply", type: "text-start" },
          { delta: "I will read Alice's note again.", id: "reply", type: "text-delta" },
          { id: "reply", type: "text-end" },
          finish("stop"),
        ],
      ]),
      modelId: "output-limit-model",
      provider: "eve-integration-mock",
    });
    const execute = vi.fn(async () => ({ text: "Meeting moved to Friday." }));
    const runStep = createToolLoopHarness({
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map([
        [
          "read_note",
          {
            name: "read_note",
            description: "Read one of Alice's notes.",
            execute,
            inputSchema: jsonSchema({
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            }),
          },
        ],
      ]),
    });
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "output-limit-model" },
        system: "Help Alice with her notes.",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "task:output-limit-session",
      history: [],
      sessionId: "output-limit-session",
    };

    const cutShortStep = await runStep(session, { message: "Read Alice's and Bob's notes." });
    if (typeof cutShortStep.next !== "function") {
      throw new TypeError("Expected the cut-short step to continue the tool loop.");
    }
    const nextStep = await cutShortStep.next(cutShortStep.session);

    expect(execute).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(2);
    const retryPrompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(findToolResult(retryPrompt, skippedCallId)).toMatchObject({
      output: { type: "error-text", value: expect.stringContaining("finish reason: length") },
    });
    for (const call of truncated) {
      expect(findToolResult(retryPrompt, call.toolCallId)).toBeDefined();
    }
    expect(nextStep.next).toBeNull();
  });

  it("settles a streamed call cut short at the output limit before the step completes", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            input: JSON.stringify({ path: "notes/alice.md" }),
            toolCallId: "read-skipped",
            toolName: "read_note",
            type: "tool-call",
          },
          { finishReason: { raw: undefined, unified: "length" }, type: "finish", usage },
        ]),
      }),
      modelId: "output-limit-model",
      provider: "eve-integration-mock",
    });
    const events: string[] = [];
    const runStep = createToolLoopHarness({
      handleEvent: async (event) => {
        if (event.type === "action.result") {
          events.push(
            `action.result:${event.data.result.callId}:${String(event.data.result.isError)}`,
          );
        } else {
          events.push(event.type);
        }
      },
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map([
        [
          "read_note",
          {
            name: "read_note",
            description: "Read one of Alice's notes.",
            execute: async () => ({ text: "Meeting moved to Friday." }),
            inputSchema: jsonSchema({ type: "object" }),
          },
        ],
      ]),
    });

    await runStep(
      {
        agent: {
          modelReference: { id: "output-limit-model" },
          system: "Help Alice with her notes.",
          tools: [],
        },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "task:output-limit-stream-session",
        history: [],
        sessionId: "output-limit-stream-session",
      },
      { message: "Read Alice's note." },
    );

    const stepEvents = events.slice(events.indexOf("step.started"));
    expect(stepEvents.slice(0, 4)).toEqual([
      "step.started",
      "actions.requested",
      "action.result:read-skipped:true",
      "step.completed",
    ]);
  });
});
