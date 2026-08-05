import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

function createSession(tools: HarnessSession["agent"]["tools"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "tool-streaming-model" },
      system: "You are a test assistant.",
      tools,
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:tool-streaming-session",
    history: [{ content: "Index the documents.", role: "user" }],
    sessionId: "tool-streaming-session",
  };
}

function createEventCollector(): {
  readonly emit: HarnessEmitFn;
  readonly events: UnstampedMessageStreamEvent[];
} {
  const events: UnstampedMessageStreamEvent[] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function enqueueToolCall(controller: ReadableStreamDefaultController<StreamPart>): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({
    input: JSON.stringify({ target: "documents" }),
    toolCallId: "call-stream-1",
    toolName: "long_task",
    type: "tool-call",
  });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "tool-calls" },
    type: "finish",
    usage,
  });
  controller.close();
}

function enqueueTextSuccess(
  controller: ReadableStreamDefaultController<StreamPart>,
  text: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "answer", type: "text-start" });
  controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
  controller.enqueue({ id: "answer", type: "text-end" });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage,
  });
  controller.close();
}

describe("tool loop streaming tool execution", () => {
  it("streams action.partial snapshots and records only the last yield as the result", async () => {
    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          if (attempt === 1) {
            enqueueToolCall(controller);
            return;
          }
          enqueueTextSuccess(controller, "Indexing finished.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "tool-streaming-model",
      provider: "eve-integration-mock",
    });

    const longTask: HarnessToolDefinition = {
      description: "Index documents with progress updates.",
      async *execute() {
        yield { progress: 0.25 };
        yield { progress: 0.5 };
        yield { indexed: 42, progress: 1 };
      },
      inputSchema: jsonSchema({ type: "object" }),
      name: "long_task",
    };
    const tools: ToolLoopHarnessConfig["tools"] = new Map([["long_task", longTask]]);
    const { emit, events } = createEventCollector();
    const config: ToolLoopHarnessConfig = {
      handleEvent: emit,
      mode: "task",
      resolveModel: vi.fn().mockResolvedValue(model as LanguageModel),
      tools,
    };

    let result = await createToolLoopHarness(config)(
      createSession([
        {
          description: longTask.description,
          inputSchema: { type: "object" },
          name: "long_task",
        },
      ]),
      { message: "Continue." },
    );
    while (typeof result.next === "function") {
      result = await result.next(result.session);
    }

    expect(result.next).toEqual({ done: true, output: "Indexing finished." });

    const actionEvents = events.filter(
      (event) =>
        event.type === "actions.requested" ||
        event.type === "action.partial" ||
        event.type === "action.result",
    );
    // Every yield surfaces as a preliminary snapshot — including the last
    // one, which the SDK then repeats as the terminal result.
    expect(actionEvents.map((event) => event.type)).toEqual([
      "actions.requested",
      "action.partial",
      "action.partial",
      "action.partial",
      "action.result",
    ]);
    expect(actionEvents[1]).toMatchObject({
      data: {
        result: {
          callId: "call-stream-1",
          kind: "tool-result",
          output: { progress: 0.25 },
          toolName: "long_task",
        },
      },
      type: "action.partial",
    });
    expect(actionEvents[2]).toMatchObject({
      data: { result: { output: { progress: 0.5 } } },
      type: "action.partial",
    });
    expect(actionEvents[3]).toMatchObject({
      data: { result: { output: { indexed: 42, progress: 1 } } },
      type: "action.partial",
    });
    // The terminal result is the last yield.
    expect(actionEvents[4]).toMatchObject({
      data: {
        result: { callId: "call-stream-1", output: { indexed: 42, progress: 1 } },
        status: "completed",
      },
      type: "action.result",
    });

    // Durable model-facing history records only the terminal value.
    const history = JSON.stringify(result.session.history);
    expect(history).toContain('"indexed":42');
    expect(history).not.toContain("0.25");
  });
});
