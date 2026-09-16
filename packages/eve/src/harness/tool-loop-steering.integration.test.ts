import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

function session(): HarnessSession {
  return {
    agent: { modelReference: { id: "steering-model" }, system: "Test assistant", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "steering-session",
    history: [],
    sessionId: "steering-session",
  };
}

function finish(controller: ReadableStreamDefaultController<Part>, text: string): void {
  controller.enqueue({ type: "text-start", id: "answer" });
  controller.enqueue({ type: "text-delta", id: "answer", delta: text });
  controller.enqueue({ type: "text-end", id: "answer" });
  controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
  controller.close();
}

describe("generation steering with the real AI SDK", () => {
  it("commits the original input and turn preamble when steering precedes model startup", async () => {
    const steering = new AbortController();
    steering.abort();
    const doStream = vi.fn<MockLanguageModelV3["doStream"]>();
    const model = new MockLanguageModelV3({ doStream });
    const events: UnstampedMessageStreamEvent[] = [];
    const result = await createToolLoopHarness({
      mode: "conversation",
      steeringSignal: steering.signal,
      tools: new Map(),
      resolveModel: async () => model,
      handleEvent: async (event) => {
        events.push(event);
      },
    })(session(), { message: "Original request" });
    expect(result.steered).toBe(true);
    expect(doStream).not.toHaveBeenCalled();
    expect(JSON.stringify(result.session.history)).toContain("Original request");
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(
      events.some((event) => event.type === "turn.completed" || event.type === "turn.cancelled"),
    ).toBe(false);
  });
  it("interrupts before provider search, drops late output, and resumes the same turn", async () => {
    const steering = new AbortController();
    const reasoning = Promise.withResolvers<void>();
    const events: UnstampedMessageStreamEvent[] = [];
    let firstStream: ReadableStreamDefaultController<Part>;
    let providerSignal: AbortSignal | undefined;
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockImplementationOnce(async (options) => {
        providerSignal = options.abortSignal;
        return {
          stream: new ReadableStream<Part>({
            start(controller) {
              firstStream = controller;
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "reasoning-start", id: "thinking" });
              controller.enqueue({
                type: "reasoning-delta",
                id: "thinking",
                delta: "Checking the year",
              });
            },
          }),
        };
      })
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream<Part>({
          start(controller) {
            finish(controller, "Corrected 2025 answer");
          },
        }),
      }));
    const model = new MockLanguageModelV3({ doStream });
    const createStep = (signal?: AbortSignal) =>
      createToolLoopHarness({
        mode: "conversation",
        resolveModel: async () => model,
        tools: new Map(),
        steeringSignal: signal,
        handleEvent: async (event) => {
          events.push(event);
          if (event.type === "reasoning.appended") reasoning.resolve();
        },
      });
    const running = createStep(steering.signal)(session(), { message: "Who won in 2026?" });
    await reasoning.promise;
    steering.abort();
    const interrupted = await running;
    expect(providerSignal?.aborted).toBe(true);
    expect(interrupted.steered).toBe(true);
    expect(getHarnessEmissionState(interrupted.session.state).turnId).toBe("turn_0");
    // The provider ignores abort and finishes its obsolete request anyway.
    firstStream!.enqueue({
      type: "tool-call",
      toolCallId: "search",
      toolName: "web_search",
      input: "{}",
      providerExecuted: true,
    });
    finish(firstStream!, "Stale 2026 answer");
    const result = await createStep()(interrupted.session, { message: "Actually 2025" });
    expect(result.steered).toBeUndefined();
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.received")).toHaveLength(2);
    expect(
      events.some((event) => event.type === "turn.cancelled" || event.type === "turn.failed"),
    ).toBe(false);
    const answers = events
      .filter((event) => event.type === "message.appended")
      .map((event) => event.data.messageDelta)
      .join("");
    expect(answers).toBe("Corrected 2025 answer");
    expect(JSON.stringify(doStream.mock.calls[1]?.[0].prompt)).toContain("Who won in 2026?");
    expect(JSON.stringify(doStream.mock.calls[1]?.[0].prompt)).toContain("Actually 2025");
    expect(JSON.stringify(doStream.mock.calls[1]?.[0].prompt)).not.toContain("Stale");
  });

  it("finishes a local tool once and preserves its result for the corrected model call", async () => {
    const steering = new AbortController();
    const executing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(async () => {
      executing.resolve();
      await release.promise;
      return "saved";
    });
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "save-1",
              toolName: "save",
              input: "{}",
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      }))
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream<Part>({
          start(controller) {
            finish(controller, "Corrected");
          },
        }),
      }));
    const model = new MockLanguageModelV3({ doStream });
    const createStep = (signal?: AbortSignal) =>
      createToolLoopHarness({
        mode: "conversation",
        steeringSignal: signal,
        resolveModel: async () => model,
        handleEvent: async () => {},
        tools: new Map([
          [
            "save",
            {
              name: "save",
              description: "Save once",
              inputSchema: jsonSchema({ type: "object" }),
              execute,
            },
          ],
        ]),
      });
    const running = createStep(steering.signal)(session(), { message: "Save this" });
    await executing.promise;
    steering.abort();
    release.resolve();
    const completed = await running;
    expect(completed.steered).toBeUndefined();
    await createStep()(completed.session, { message: "Use the corrected year" });
    expect(execute).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(doStream.mock.calls[1]?.[0].prompt);
    expect(prompt).toContain("saved");
    expect(prompt).toContain("Use the corrected year");
  });

  it("does not interrupt after assistant text has been published", async () => {
    const steering = new AbortController();
    const events: UnstampedMessageStreamEvent[] = [];
    let providerSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        providerSignal = options.abortSignal;
        return {
          stream: new ReadableStream<Part>({
            start(controller) {
              finish(controller, "Already streaming");
            },
          }),
        };
      },
    });
    const result = await createToolLoopHarness({
      mode: "conversation",
      steeringSignal: steering.signal,
      tools: new Map(),
      resolveModel: async () => model,
      handleEvent: async (event) => {
        events.push(event);
        if (event.type === "message.appended") steering.abort();
      },
    })(session(), { message: "Start" });
    expect(result.steered).toBeUndefined();
    expect(providerSignal?.aborted).toBe(false);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});
