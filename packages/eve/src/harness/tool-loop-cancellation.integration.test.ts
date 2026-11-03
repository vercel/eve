import type { SessionEvent } from "#protocol/session-event.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createKernel } from "#harness/kernel.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessEmitFn, HarnessSession, KernelConfig } from "#harness/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const FAILURE_EVENT_TYPES = ["step.failed", "turn.failed", "session.failed"] as const;

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "integration-model" },
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
  events: SessionEvent[];
} {
  const events: SessionEvent[] = [];
  const emit: HarnessEmitFn = eachEvent(async (event) => {
    events.push(event);
  });
  return { emit, events };
}

function createConfig(
  model: LanguageModel,
  emit: HarnessEmitFn,
  overrides?: Partial<KernelConfig>,
): KernelConfig {
  return {
    handleEvent: emit,
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
    const runStep = createKernel(
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

  // #5025: a cancelled model call is not a failed attempt; instrumentation hears `model.retried`
  // as one.
  it("neither fails nor retries the model call a cancellation cuts short", async () => {
    const abortController = new AbortController();
    const model = new MockLanguageModelV3({
      modelId: "integration-model",
      provider: "eve-integration-mock",
      doStream: async () => {
        // A cancellation can reach the step without its reason, so the stream rejects with the
        // platform's plain AbortError.
        abortController.abort();
        throw abortController.signal.reason;
      },
    });
    const { emit, events } = createEventCollector();
    const runStep = createKernel(
      createConfig(model, emit, { abortSignal: abortController.signal }),
    );

    await expect(
      runStep(createSession(), { message: "Summarize Alice's notes." }),
    ).rejects.toBeInstanceOf(TurnCancelledError);

    expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "model.retried" ||
          (event.type === "model.settled" && event.data.outcome === "failed"),
      ),
    ).toEqual([]);
  });

  // #4273: a resolver can raise the cancellation before the turn's signal fires.
  it("propagates a model resolver cancellation raised before the signal aborts", async () => {
    const logs = captureLogRecords();
    const cancellation = new TurnCancelledError();
    const { emit, events } = createEventCollector();
    const runStep = createKernel(
      createConfig(new MockLanguageModelV3(), emit, {
        abortSignal: new AbortController().signal,
        resolveModel: vi.fn().mockRejectedValue(cancellation),
      }),
    );

    await expect(runStep(createSession(), { message: "Hi" })).rejects.toBe(cancellation);

    expect(events.map((event) => event.type)).not.toContain("session.ended");
    expect(logs.records).not.toContainEqual(
      expect.objectContaining({ message: "model selection failed terminally" }),
    );
  });

  it("fails the session when the model resolver throws an ordinary error", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createKernel(
      createConfig(new MockLanguageModelV3(), emit, {
        abortSignal: new AbortController().signal,
        resolveModel: vi.fn().mockRejectedValue(new Error("No provider for integration-model.")),
      }),
    );

    await runStep(createSession(), { message: "Hi" });

    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.objectContaining({ code: "MODEL_SELECTION_FAILED" }),
          outcome: "failed",
        }),
        type: "session.ended",
      }),
    );
  });

  it("forwards a live signal to executing tools and discards the straggler result", async () => {
    const logs = captureLogRecords();
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

    const tools: KernelConfig["tools"] = new Map([
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
    const runStep = createKernel(
      createConfig(model, emit, { abortSignal: abortController.signal, tools }),
    );

    const session: HarnessSession = {
      ...createSession(),
      agent: {
        modelReference: { id: "integration-model" },
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
    expect(logs.records).not.toContainEqual(
      expect.objectContaining({ message: "tool execution failed" }),
    );
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
    const inertResult = await createKernel(
      createConfig(buildModel(), inert.emit, { abortSignal: new AbortController().signal }),
    )(createSession(), { message: "Hi" });

    const bare = createEventCollector();
    const bareResult = await createKernel(createConfig(buildModel(), bare.emit))(createSession(), {
      message: "Hi",
    });

    expect(inertResult.next).toBe(bareResult.next);
    expect(inert.events.map((event) => event.type)).toEqual(bare.events.map((event) => event.type));
  });
});
