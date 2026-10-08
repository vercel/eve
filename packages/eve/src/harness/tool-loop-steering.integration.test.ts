import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import {
  inlineTool,
  subagentTool,
  toolMap,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";
import {
  foldingHandler,
  parkedSteps,
  positionOf,
  withOpenTurn,
} from "#internal/testing/session-machine.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  TOOL_RESULT_BOUNDARY,
} from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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
  it.each(["steer", "cancel"] as const)("wakes retry backoff immediately on %s", async (kind) => {
    vi.useFakeTimers();
    const retrying = Promise.withResolvers<void>();
    const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (String(message).includes("retrying")) retrying.resolve();
    });
    const streamError = vi.spyOn(console, "error").mockImplementation(() => {});
    const steering = new AbortController();
    const cancellation = new AbortController();
    const doStream = vi.fn<MockLanguageModelV3["doStream"]>(async () => ({
      stream: new ReadableStream<Part>({
        start(controller) {
          controller.enqueue({
            type: "error",
            error: Object.assign(new Error("Connection interrupted"), { isRetryable: true }),
          });
          controller.close();
        },
      }),
    }));
    try {
      const running = createToolLoopHarness({
        abortSignal: cancellation.signal,
        steeringSignal: steering.signal,
        tools: new Map(),
        resolveModel: async () => new MockLanguageModelV3({ doStream }),
        handleEvent: async () => {},
      })(session(), { message: "Prepare Alice's report" });
      await retrying.promise;
      if (kind === "cancel") cancellation.abort(new TurnCancelledError());
      steering.abort();
      if (kind === "cancel") await expect(running).rejects.toBeInstanceOf(TurnCancelledError);
      else expect((await running).steered).toBe(true);
      expect(doStream).toHaveBeenCalledOnce();
      expect(streamError).toHaveBeenCalledWith(
        "[eve:harness.tool-loop] tool-loop stream error",
        expect.anything(),
      );
    } finally {
      warning.mockRestore();
      streamError.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["input.requested", "turn.waiting", "step.failed"] as const)(
    "finishes committing %s when a correction arrives during publication",
    async (boundary) => {
      const logs = captureLogRecords();
      const steering = new AbortController();
      const events: UnstampedMessageStreamEvent[] = [];
      const model = new MockLanguageModelV3({
        doStream: async () => {
          if (boundary === "step.failed") throw new Error("Model unavailable");
          return {
            stream: new ReadableStream<Part>({
              start(controller) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "publish-1",
                  toolName: "publish_report",
                  input: JSON.stringify({}),
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: undefined },
                  usage,
                });
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createToolLoopHarness({
        capabilities: { requestInput: true },
        steeringSignal: steering.signal,
        tools: new Map([
          [
            "publish_report",
            {
              approval: always(),
              name: "publish_report",
              description: "Publish Alice's report after approval",
              execute: async () => ({ published: true }),
              inputSchema: jsonSchema({ type: "object" }),
            },
          ],
        ]),
        resolveModel: async () => model,
        handleEvent: foldingHandler(async (event) => {
          events.push(event);
          if (event.type === boundary) steering.abort();
        }),
      });
      const ctx = new ContextContainer();
      ctx.set(SessionKey, {
        auth: { current: null, initiator: null },
        sessionId: session().sessionId,
        turn: { id: "turn_0", sequence: 0 },
      });
      const result = await contextStorage.run(ctx, () =>
        harness(session(), { message: "Report only if there is a new update" }),
      );
      expect(result.steered).toBeUndefined();
      expect(result.next).toBeNull();
      expect(events.filter((event) => event.type === boundary)).toHaveLength(1);
      // A failed step ends the turn; an approval holds it open.
      const endsTurn = boundary === "step.failed";
      expect(events.filter((event) => event.type === "session.waiting")).toHaveLength(
        endsTurn ? 1 : 0,
      );
      expect(events.filter((event) => event.type === "turn.waiting")).toHaveLength(
        endsTurn ? 0 : 1,
      );
      expect(events.filter((event) => event.type === "message.appended")).toHaveLength(0);
      const parked = logs.records.filter(
        (record) => record.message === "model call failed — parking session for retry by the user",
      );
      expect(parked).toHaveLength(boundary === "step.failed" ? 1 : 0);
    },
  );

  it("commits the original input and turn preamble when steering precedes model startup", async () => {
    const steering = new AbortController();
    steering.abort();
    const doStream = vi.fn<MockLanguageModelV3["doStream"]>();
    const model = new MockLanguageModelV3({ doStream });
    const events: UnstampedMessageStreamEvent[] = [];
    const result = await createToolLoopHarness({
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
    expect(positionOf(interrupted.session).turnId).toBe("turn_0");
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

  it("ends the superseded step with a terminal step event before the next step starts", async () => {
    const steering = new AbortController();
    const pending = Promise.withResolvers<void>();
    const events: UnstampedMessageStreamEvent[] = [];
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockImplementationOnce(async () => {
        pending.resolve();
        return { stream: new ReadableStream<Part>() };
      })
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream<Part>({
          start(controller) {
            finish(controller, "Corrected 2025 report");
          },
        }),
      }));
    const model = new MockLanguageModelV3({ doStream });
    const createStep = (signal?: AbortSignal) =>
      createToolLoopHarness({
        resolveModel: async () => model,
        tools: new Map(),
        steeringSignal: signal,
        handleEvent: async (event) => {
          events.push(event);
        },
      });
    const running = createStep(steering.signal)(session(), {
      message: "Alice is preparing the 2026 report.",
    });
    await pending.promise;
    steering.abort();
    const interrupted = await running;
    expect(interrupted.steered).toBe(true);
    await createStep()(interrupted.session, {
      message: "Alice corrected the report year to 2025.",
    });
    const stepEvents = events
      .filter((event) => ["step.started", "step.completed", "step.failed"].includes(event.type))
      .map((event) => `${event.type}:${(event.data as { stepIndex: number }).stepIndex}`);
    expect(stepEvents).toEqual([
      "step.started:0",
      expect.stringMatching(/^step\.(completed|failed):0$/),
      "step.started:1",
      "step.completed:1",
    ]);
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
    // The correction starts its own user turn instead of joining the tool result's.
    const roles = (call: number) => doStream.mock.calls[call]![0].prompt.map(({ role }) => role);
    expect(roles(0)).toEqual(["system", "user"]);
    expect(roles(1)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(doStream.mock.calls[1]![0].prompt.at(-2)).toMatchObject({
      content: [{ text: TOOL_RESULT_BOUNDARY, type: "text" }],
    });
  });

  it("starts a steering message's own user turn after tool results followed by a framework note", async () => {
    const doStream = vi.fn<MockLanguageModelV3["doStream"]>(async () => ({
      stream: new ReadableStream<Part>({
        start(controller) {
          finish(controller, "Quarterly Business Review");
        },
      }),
    }));
    const heldTurn = withOpenTurn(
      {
        ...session(),
        history: [
          createUserMessage("user", "Compile Alice's churn report"),
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "report-1", toolName: "report", input: {} }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "report-1",
                toolName: "report",
                output: { type: "text", value: "Started task report-1." },
              },
            ],
          },
          createFrameworkUserMessage("context.state", "Alice's reports are due Monday."),
        ],
      },
      { sequence: 0, stepIndex: 1, turnId: "turn_0" },
    );
    await createToolLoopHarness({
      handleEvent: async () => {},
      resolveModel: async () => new MockLanguageModelV3({ doStream }),
      tools: new Map(),
    })(heldTurn, { message: "What does QBR stand for?" });
    const prompt = doStream.mock.calls[0]![0].prompt;
    expect(prompt.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "user",
    ]);
    expect(prompt.at(-2)).toMatchObject({
      content: [{ text: TOOL_RESULT_BOUNDARY, type: "text" }],
    });
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

  it.each([
    ["a workflow tool directly", workflowTool("deploy_service"), "deploy_service", {}],
    [
      "a workflow tool through execute",
      workflowTool("deploy_service", "execute", { deferred: true }),
      EXECUTE_TOOL_NAME,
      { tool: "deploy_service" },
    ],
    [
      "an agent through execute",
      subagentTool("billing_specialist", { deferred: true }),
      EXECUTE_TOOL_NAME,
      { input: { message: "Review Bob's dispute." }, tool: "billing_specialist" },
    ],
  ] as const)(
    "interrupts a step that calls %s, since it runs only after the step",
    async (_case, entry, toolName, input) => {
      const steering = new AbortController();
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream<Part>({
            start(controller) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call-1",
                toolName,
                input: JSON.stringify(input),
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
        }),
      });
      const result = await createToolLoopHarness({
        steeringSignal: steering.signal,
        tools: toolMap(entry),
        resolveModel: async () => model,
        handleEvent: async (event) => {
          if (event.type === "actions.requested") steering.abort();
        },
      })(session(), { message: "Alice asks for the work to start" });

      expect(result.steered).toBe(true);
      expect(parkedSteps(result.session)).toEqual([]);
    },
  );

  it("does not interrupt a step once an inline entry called through execute is running", async () => {
    const steering = new AbortController();
    const executing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refund = vi.fn(async () => {
      executing.resolve();
      await release.promise;
      return { refunded: true };
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "refund-1",
              toolName: EXECUTE_TOOL_NAME,
              input: JSON.stringify({ input: {}, tool: "refund_invoice" }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      }),
    });
    const running = createToolLoopHarness({
      steeringSignal: steering.signal,
      tools: toolMap(inlineTool("refund_invoice", { deferred: true, execute: refund })),
      resolveModel: async () => model,
      handleEvent: async () => {},
    })(session(), { message: "Alice asks for a refund of invoice in_1" });
    await executing.promise;
    steering.abort();
    release.resolve();

    expect((await running).steered).toBeUndefined();
    expect(refund).toHaveBeenCalledOnce();
  });
});
