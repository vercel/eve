import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};
const providerMetadata = { gateway: { generationId: "gen_filtered" } };
const finishReason = { unified: "content-filter", raw: "content_filter" } as const;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

function session(): HarnessSession {
  return {
    agent: { modelReference: { id: "filtered-model" }, system: "Help Alice and Bob.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:filtered-session",
    history: [],
    sessionId: "filtered-session",
  };
}

describe("content-filter reporting (real AI SDK)", () => {
  it.each(["", "Alice's inventory list is"])(
    "reports a filtered stream without retry or successful delivery: %j",
    async (text) => {
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          const chunks: StreamPart[] = [{ type: "stream-start", warnings: [] }];
          if (text !== "")
            chunks.push(
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: text },
              { type: "text-end", id: "answer" },
            );
          chunks.push({ type: "finish", finishReason, usage, providerMetadata });
          return { stream: simulateReadableStream({ chunks }) };
        },
      });
      const events: UnstampedMessageStreamEvent[] = [];
      const step = createToolLoopHarness({
        mode: "conversation",
        resolveModel: async () => model,
        tools: new Map(),
        handleEvent: async (event) => {
          events.push(event);
        },
      });
      const result = await step(session(), { message: "Help Alice prepare Bob's inventory list." });
      expect(calls).toBe(1);
      expect(result.next).toBeNull();
      expect(events.find((event) => event.type === "step.failed")).toMatchObject({
        data: {
          message: "The model provider filtered this response.",
          details: {
            finishReason: "content-filter",
            generationId: "gen_filtered",
            semanticErrorId: "model-response-content-filtered",
          },
        },
      });
      expect(
        events.some(
          (event) =>
            event.type === "message.completed" ||
            event.type === "step.completed" ||
            event.type === "turn.completed",
        ),
      ).toBe(false);
      expect(events.some((event) => event.type === "session.waiting")).toBe(true);
    },
  );

  it.each(["", "Alice's inventory list is"])(
    "rejects a filtered generated response without retry: %j",
    async (text) => {
      let calls = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          calls++;
          return {
            content: text === "" ? [] : [{ type: "text", text }],
            finishReason,
            usage,
            providerMetadata,
            warnings: [],
          };
        },
      });
      const step = createToolLoopHarness({
        mode: "task",
        resolveModel: async () => model,
        tools: new Map(),
      });
      await expect(
        step(session(), { message: "Help Alice prepare Bob's inventory list." }),
      ).rejects.toMatchObject({
        name: "ContentFilteredModelResponseError",
        generationId: "gen_filtered",
      });
      expect(calls).toBe(1);
    },
  );
});
