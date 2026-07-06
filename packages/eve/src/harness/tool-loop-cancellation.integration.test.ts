import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const FAILURE_EVENT_TYPES = ["step.failed", "turn.failed", "session.failed"] as const;

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "integration-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:integration-session",
    history: [],
    sessionId: "integration-session",
  };
}

function createEventCollector(): {
  emit: HarnessEmitFn;
  events: HandleMessageStreamEvent[];
} {
  const events: HandleMessageStreamEvent[] = [];
  const emit: HarnessEmitFn = async (event) => {
    events.push(event);
  };
  return { emit, events };
}

function createConfig(
  model: LanguageModel,
  emit: HarnessEmitFn,
  overrides?: Partial<ToolLoopHarnessConfig>,
): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    mode: "conversation",
    resolveModel: vi.fn().mockResolvedValue(model),
    tools: new Map(),
    ...overrides,
  };
}

function createHangingStreamModel(onStreamStarted: () => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "integration-model",
    provider: "eve-integration-mock",
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ id: "text-1", type: "text-start" });
          controller.enqueue({ delta: "Working on it", id: "text-1", type: "text-delta" });
          onStreamStarted();
        },
      }),
    }),
  });
}

describe("tool loop cancellation (real AI SDK)", () => {
  it("aborting mid-stream settles with the canonical cancellation and no failure events", async () => {
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();
    const model = createHangingStreamModel(() => {
      abortController.abort(cancellation);
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createConfig(model, emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createSession(), { message: "Do a lot of work" })).rejects.toBe(
      cancellation,
    );

    const eventTypes = events.map((event) => event.type);
    for (const failureType of FAILURE_EVENT_TYPES) {
      expect(eventTypes).not.toContain(failureType);
    }
  });

  it("forwards a live signal to executing tools and discards the straggler result", async () => {
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();

    let toolSignal: AbortSignal | undefined;
    let toolSignalAborted = false;

    const doStream = vi.fn().mockImplementation(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            input: JSON.stringify({}),
            toolCallId: "call-wait-1",
            toolName: "wait_for_cancel",
            type: "tool-call",
          });
          controller.enqueue({
            finishReason: { raw: undefined, unified: "tool-calls" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          });
          controller.close();
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      modelId: "integration-model",
      provider: "eve-integration-mock",
      doStream,
    });

    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "wait_for_cancel",
        {
          description: "Waits until the turn is cancelled.",
          execute: (_input: unknown, options?: ToolExecuteOptions) => {
            toolSignal = options?.abortSignal;
            return new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => {
                  toolSignalAborted = true;
                  reject(options.abortSignal?.reason);
                },
                { once: true },
              );
              abortController.abort(cancellation);
            });
          },
          inputSchema: jsonSchema({ type: "object" }),
          name: "wait_for_cancel",
        },
      ],
    ]);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createConfig(model, emit, { abortSignal: abortController.signal, tools }),
    );

    const session: HarnessSession = {
      ...createSession(),
      agent: {
        modelReference: { id: "integration-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Waits until the turn is cancelled.",
            inputSchema: { type: "object" },
            name: "wait_for_cancel",
          },
        ],
      },
    };

    await expect(runStep(session, { message: "wait for cancel" })).rejects.toBe(cancellation);

    expect(doStream).toHaveBeenCalledTimes(1);
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolSignalAborted).toBe(true);

    const eventTypes = events.map((event) => event.type);
    for (const failureType of FAILURE_EVENT_TYPES) {
      expect(eventTypes).not.toContain(failureType);
    }
  });

  it("leaves behavior unchanged when the signal never aborts", async () => {
    const buildModel = (): MockLanguageModelV3 =>
      new MockLanguageModelV3({
        modelId: "integration-model",
        provider: "eve-integration-mock",
        doStream: async () => ({
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "text-1", type: "text-start" });
              controller.enqueue({ delta: "All done.", id: "text-1", type: "text-delta" });
              controller.enqueue({ id: "text-1", type: "text-end" });
              controller.enqueue({
                finishReason: { raw: undefined, unified: "stop" },
                type: "finish",
                usage: {
                  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                  outputTokens: { reasoning: 0, text: 1, total: 1 },
                },
              });
              controller.close();
            },
          }),
        }),
      });

    const inert = createEventCollector();
    const inertResult = await createToolLoopHarness(
      createConfig(buildModel(), inert.emit, { abortSignal: new AbortController().signal }),
    )(createSession(), { message: "Hi" });

    const bare = createEventCollector();
    const bareResult = await createToolLoopHarness(createConfig(buildModel(), bare.emit))(
      createSession(),
      { message: "Hi" },
    );

    expect(inertResult.next).toBe(bareResult.next);
    expect(inert.events.map((event) => event.type)).toEqual(bare.events.map((event) => event.type));
  });
});
