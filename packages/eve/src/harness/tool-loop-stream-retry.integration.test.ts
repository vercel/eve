import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultMessageReducer } from "#client/message-reducer.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "retry-integration-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:retry-integration-session",
    history: [
      { content: "Complete the long task.", kind: "user", role: "user" },
      { content: "Prior work is complete.", role: "assistant" },
    ],
    sessionId: "retry-integration-session",
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

function createConfig(
  model: LanguageModel,
  emit: HarnessEmitFn,
  tools: ToolLoopHarnessConfig["tools"] = new Map(),
): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    resolveModel: vi.fn().mockResolvedValue(model),
    tools,
  };
}

function enqueueOverload(
  controller: ReadableStreamDefaultController<StreamPart>,
  partialText?: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  if (partialText !== undefined) {
    controller.enqueue({ id: "partial", type: "text-start" });
    controller.enqueue({ delta: partialText, id: "partial", type: "text-delta" });
    controller.enqueue({ id: "partial", type: "text-end" });
  }
  controller.enqueue({
    error: { message: "Overloaded", type: "overloaded_error" },
    type: "error",
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

function enqueueToolCall(
  controller: ReadableStreamDefaultController<StreamPart>,
  callId: string,
  note: string,
): void {
  const input = JSON.stringify({ note });
  controller.enqueue({ id: callId, toolName: "save_note", type: "tool-input-start" });
  controller.enqueue({ delta: input, id: callId, type: "tool-input-delta" });
  controller.enqueue({ id: callId, type: "tool-input-end" });
  controller.enqueue({ input, toolCallId: callId, toolName: "save_note", type: "tool-call" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tool loop streamed provider retries", () => {
  it("settles tool calls emitted by an abandoned retry attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (attempt === 1) {
            enqueueToolCall(controller, "call_a1", "first note");
            controller.enqueue({ id: "call_a2", toolName: "save_note", type: "tool-input-start" });
            controller.enqueue({
              delta: '{"note":"second',
              id: "call_a2",
              type: "tool-input-delta",
            });
            controller.enqueue({
              error: { message: "Overloaded", type: "overloaded_error" },
              type: "error",
            });
            controller.close();
            return;
          }
          if (attempt === 2) {
            enqueueToolCall(controller, "call_b1", "first note");
            enqueueToolCall(controller, "call_b2", "second note");
            controller.enqueue({
              finishReason: { raw: undefined, unified: "tool-calls" },
              type: "finish",
              usage,
            });
            controller.close();
            return;
          }
          enqueueTextSuccess(controller, "Notes saved.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const execute = vi.fn(async ({ note }: { readonly note: string }) => ({ saved: note }));
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "save_note",
        {
          description: "Save a note.",
          execute,
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: { note: { type: "string" } },
            required: ["note"],
            type: "object",
          }),
          name: "save_note",
        },
      ],
    ]);
    const { emit, events } = createEventCollector();

    const toolStep = await createToolLoopHarness(createConfig(model, emit, tools))(
      createSession(),
      {
        message: "Save both notes.",
      },
    );
    if (typeof toolStep.next !== "function") {
      throw new TypeError("Expected tool calls to continue the tool loop.");
    }
    await toolStep.next(toolStep.session);

    expect(doStream).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    const retryStart = events.findIndex(
      (event) =>
        (event.type === "action.input.appended" && event.data.callId === "call_b1") ||
        (event.type === "actions.requested" &&
          event.data.actions.some((action) => action.callId === "call_b1")),
    );
    const abandonedResults = events.filter(
      (event) =>
        event.type === "action.result" &&
        (event.data.result.callId === "call_a1" || event.data.result.callId === "call_a2"),
    );
    expect(abandonedResults).toHaveLength(2);
    expect(abandonedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            error: expect.objectContaining({ message: expect.stringMatching(/retried/i) }),
            result: expect.objectContaining({ callId: "call_a1", isError: true }),
            status: "failed",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            error: expect.objectContaining({ message: expect.stringMatching(/retried/i) }),
            result: expect.objectContaining({ callId: "call_a2", isError: true }),
            status: "failed",
          }),
        }),
      ]),
    );
    expect(events.indexOf(abandonedResults[1]!)).toBeLessThan(retryStart);

    const reducer = defaultMessageReducer();
    const projection = stampTestEvents(events).reduce(reducer.reduce, reducer.initial());
    expect(
      projection.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "dynamic-tool" ? [[part.toolCallId, part.state]] : [],
        ),
      ),
    ).toEqual([
      ["call_b1", "output-available"],
      ["call_b2", "output-available"],
    ]);
  });

  it("settles each abandoned call once when a settlement publish fails and retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (attempt === 1) {
            enqueueToolCall(controller, "call_a1", "first note");
            enqueueToolCall(controller, "call_a2", "second note");
            controller.enqueue({
              error: { message: "Overloaded", type: "overloaded_error" },
              type: "error",
            });
            controller.close();
            return;
          }
          if (attempt === 2) {
            enqueueToolCall(controller, "call_b1", "first note");
            enqueueToolCall(controller, "call_b2", "second note");
            controller.enqueue({
              finishReason: { raw: undefined, unified: "tool-calls" },
              type: "finish",
              usage,
            });
            controller.close();
            return;
          }
          enqueueTextSuccess(controller, "Notes saved.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const execute = vi.fn(async ({ note }: { readonly note: string }) => ({ saved: note }));
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "save_note",
        {
          description: "Save a note.",
          execute,
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: { note: { type: "string" } },
            required: ["note"],
            type: "object",
          }),
          name: "save_note",
        },
      ],
    ]);
    const events: UnstampedMessageStreamEvent[] = [];
    let sinkFailed = false;
    const emit: HarnessEmitFn = async (event) => {
      if (!sinkFailed && event.type === "action.result" && event.data.result.callId === "call_a2") {
        sinkFailed = true;
        // A transient sink failure the model-call retry classifies as retryable.
        throw Object.assign(new Error("Event sink unavailable"), { statusCode: 503 });
      }
      events.push(event);
    };

    const toolStep = await createToolLoopHarness(createConfig(model, emit, tools))(
      createSession(),
      { message: "Save both notes." },
    );
    if (typeof toolStep.next !== "function") {
      throw new TypeError("Expected tool calls to continue the tool loop.");
    }
    await toolStep.next(toolStep.session);

    expect(sinkFailed).toBe(true);
    // The failed settlement consumed the second attempt before it streamed.
    expect(doStream).toHaveBeenCalledTimes(3);
    const abandonedResultIds = events.flatMap((event) =>
      event.type === "action.result" &&
      (event.data.result.callId === "call_a1" || event.data.result.callId === "call_a2")
        ? [event.data.result.callId]
        : [],
    );
    expect(abandonedResultIds).toEqual(["call_a1", "call_a2"]);
    const lastAbandoned = events.findLastIndex(
      (event) => event.type === "action.result" && event.data.result.callId === "call_a2",
    );
    const replacementStart = events.findIndex(
      (event) => event.type === "action.input.appended" && event.data.callId === "call_b1",
    );
    expect(replacementStart).toBeGreaterThan(-1);
    expect(lastAbandoned).toBeLessThan(replacementStart);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries an overloaded stream and preserves prior work", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          if (attempt === 1) {
            enqueueOverload(controller, "Discard this partial response.");
            return;
          }
          enqueueTextSuccess(controller, "Recovered answer.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ output: "Recovered answer." });
    expect(result.session.history).toContainEqual({
      content: "Prior work is complete.",
      role: "assistant",
    });
    expect(JSON.stringify(result.session.history)).toContain("Recovered answer.");
    expect(JSON.stringify(result.session.history)).not.toContain("Discard this partial response.");
    expect(
      events
        .filter((event) => event.type === "message.appended")
        .map((event) => event.data.messageDelta),
    ).toEqual(["Discard this partial response.", "Recovered answer."]);
    expect(
      events
        .filter((event) => event.type === "message.completed")
        .map((event) => event.data.message),
    ).toEqual(["Recovered answer."]);
    expect(events.filter((event) => event.type === "step.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "step.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(0);
  });

  it("retries a provider stream that stops sending chunks without closing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const abortSignals: (AbortSignal | undefined)[] = [];
    const doStream = vi.fn(
      async ({ abortSignal }: Parameters<MockLanguageModelV3["doStream"]>[0]) => {
        abortSignals.push(abortSignal);
        const attempt = abortSignals.length;
        return {
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              if (attempt > 1) {
                enqueueTextSuccess(controller, "Recovered answer.");
                return;
              }
              // The response body stalls mid-answer without closing. Only an abort releases it,
              // the way an aborted `fetch` errors its body.
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "stalled", type: "text-start" });
              controller.enqueue({ delta: "Partial ans", id: "stalled", type: "text-delta" });
              abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), {
                once: true,
              });
            },
          }),
        };
      },
    );
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    let settled = false;
    const run = createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    }).finally(() => {
      settled = true;
    });

    // Well past any plausible idle window for a stream that sends nothing.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(
      () => expect(settled, "the stalled model stream never released the turn").toBe(true),
      { timeout: 5_000 },
    );
    const result = await run;

    expect(abortSignals[0]?.aborted).toBe(true);
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ output: "Recovered answer." });
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
  });

  it("keeps the model call alive while an inline tool outlasts the output timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          enqueueToolCall(controller, "call_slow", "slow note");
          controller.enqueue({
            finishReason: { raw: undefined, unified: "tool-calls" },
            type: "finish",
            usage,
          });
          controller.close();
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    let toolSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async ({ note }: { readonly note: string }, options?: { abortSignal?: AbortSignal }) => {
        toolSignal = options?.abortSignal;
        await new Promise((resolve) => setTimeout(resolve, 20 * 60_000));
        return { saved: note };
      },
    );
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "save_note",
        {
          description: "Save a note.",
          execute,
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: { note: { type: "string" } },
            required: ["note"],
            type: "object",
          }),
          name: "save_note",
        },
      ],
    ]);
    const { emit, events } = createEventCollector();

    let settled = false;
    const run = createToolLoopHarness(createConfig(model, emit, tools))(createSession(), {
      message: "Save the note.",
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    await run;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolSignal?.aborted).toBe(false);
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(events.flatMap((event) => (event.type === "action.result" ? [event.data] : []))).toEqual(
      [
        expect.objectContaining({
          result: expect.objectContaining({ callId: "call_slow", output: { saved: "slow note" } }),
          status: "completed",
        }),
      ],
    );
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(0);
  });

  it("fails once after the overloaded retry attempts are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            id: `call_terminal_${attempt}`,
            toolName: "save_note",
            type: "tool-input-start",
          });
          controller.enqueue({
            delta: '{"note":"partial',
            id: `call_terminal_${attempt}`,
            type: "tool-input-delta",
          });
          controller.enqueue({
            error: { message: "Overloaded", type: "overloaded_error" },
            type: "error",
          });
          controller.close();
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(3);
    // The exhausted failure reports the catalog's curated summary for the
    // overloaded shape rather than the provider's raw "Overloaded", with
    // the remediation hint riding along in the parent-facing output.
    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({
      isError: true,
      output:
        "The model provider is overloaded or timing out upstream of AI Gateway. " +
        "This is transient — retry shortly, or switch models with `/model` in `eve dev`.",
    });
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("session.waiting");
    const abandonedResults = events.filter(
      (event) =>
        event.type === "action.result" && event.data.result.callId.startsWith("call_terminal_"),
    );
    expect(abandonedResults).toHaveLength(2);
    expect(
      abandonedResults.map((event) =>
        event.type === "action.result" ? event.data.result.callId : undefined,
      ),
    ).toEqual(["call_terminal_1", "call_terminal_2"]);
    expect(
      abandonedResults.map((event) =>
        event.type === "action.result" ? event.data.error?.message : undefined,
      ),
    ).toEqual([
      "The model call attempt was retried before this tool could run.",
      "The model call attempt was retried before this tool could run.",
    ]);
    expect(events.lastIndexOf(abandonedResults[1]!)).toBeLessThan(
      events.findIndex(
        (event) =>
          event.type === "action.input.appended" && event.data.callId === "call_terminal_3",
      ),
    );

    const reducer = defaultMessageReducer();
    const projection = stampTestEvents(events).reduce(reducer.reduce, reducer.initial());
    expect(
      projection.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "dynamic-tool"),
      ),
    ).toEqual([]);
  });
});
