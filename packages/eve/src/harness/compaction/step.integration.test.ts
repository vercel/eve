import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import { getTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

afterEach(() => {
  vi.restoreAllMocks();
});

function streamOf(parts: readonly StreamPart[]): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

const summaryStream = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "summary", type: "text-start" },
    { delta: "Alice asked for the quarterly report.", id: "summary", type: "text-delta" },
    { id: "summary", type: "text-end" },
    {
      finishReason: { raw: undefined, unified: "stop" },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 120, total: 120 },
        outputTokens: { reasoning: 0, text: 8, total: 8 },
      },
    },
  ]);

/** Manually compacts a short conversation with `model`, as `session.compact()` does. */
async function compactWith(model: MockLanguageModelV3) {
  const session: HarnessSession = {
    agent: { modelReference: { id: "summary-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 1, threshold: 100_000 },
    continuationToken: "http:compaction-session",
    history: [
      { content: "Please prepare the quarterly report.", kind: "user", role: "user" },
      { content: "I started the report.", role: "assistant" },
      { content: "Thanks, keep going.", kind: "user", role: "user" },
    ],
    sessionId: "compaction-session",
  };
  return createToolLoopHarness({
    compactOnly: true,
    handleEvent: async () => {},
    resolveModel: async () => model,
    tools: new Map(),
  })(session, {});
}

describe("compaction summary call", () => {
  it("streams a manual summary and counts its usage outside any turn", async () => {
    const doGenerate = vi.fn(async () => {
      throw new Error("Stream must be set to true");
    });
    const model = new MockLanguageModelV3({
      doGenerate,
      doStream: async () => summaryStream(),
    });

    const result = await compactWith(model);

    expect(doGenerate).not.toHaveBeenCalled();
    expect(result.session.history).toContainEqual({
      content: "Alice asked for the quarterly report.",
      role: "assistant",
    });
    // Session limits see the summary call; a manual compaction has no turn to report it.
    expect(getTurnUsageState(result.session.state)?.session).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
    });
    expect(takeSessionUsageDelta(result.session).delta).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("retries a transient stream failure like a model step", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(
        streamOf([
          { type: "stream-start", warnings: [] },
          { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" },
        ]),
      )
      .mockImplementation(async () => summaryStream());

    const result = await compactWith(new MockLanguageModelV3({ doStream }));

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.session.history).toContainEqual({
      content: "Alice asked for the quarterly report.",
      role: "assistant",
    });
  });

  it("keeps the history but counts the call when the model returns a blank summary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamOf([
          { type: "stream-start", warnings: [] },
          {
            finishReason: { raw: undefined, unified: "content-filter" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 120, total: 120 },
              outputTokens: { reasoning: 0, text: 0, total: 0 },
            },
          },
        ]),
    });

    const result = await compactWith(model);

    expect(result.session.history).toHaveLength(3);
    expect(JSON.stringify(result.session.history)).not.toContain("context.compaction");
    expect(getTurnUsageState(result.session.state)?.session).toMatchObject({ inputTokens: 120 });
  });
});

/** The rejection Anthropic returns for an over-long prompt, as the AI SDK surfaces it. */
function anthropicOverflowError(inputTokens: number, maxTokens: number): APICallError {
  const message = `prompt is too long: ${inputTokens} tokens > ${maxTokens} maximum`;
  const body = { error: { message, type: "invalid_request_error" }, type: "error" };
  return new APICallError({
    data: body,
    isRetryable: false,
    message,
    requestBodyValues: {},
    responseBody: JSON.stringify(body),
    statusCode: 400,
    url: "https://api.anthropic.com/v1/messages",
  });
}

const finish = (unified: "stop" | "tool-calls") =>
  ({
    finishReason: { raw: undefined, unified },
    type: "finish",
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 40, total: 40 },
      outputTokens: { reasoning: 0, text: 6, total: 6 },
    },
  }) as const;

const answerStream = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "answer", type: "text-start" },
    { delta: "Here is the report outline.", id: "answer", type: "text-delta" },
    { id: "answer", type: "text-end" },
    finish("stop"),
  ]);

const reportCallStream = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { input: "{}", toolCallId: "call_report", toolName: "fetch_report", type: "tool-call" },
    finish("tool-calls"),
  ]);

/** The figures Alice's report tool returns: large, but under eve's estimate of the threshold. */
const REPORT_FIGURES = "Q3 revenue by region and product line. ".repeat(7_500);

/**
 * Runs one turn, continuing through tool calls. The threshold is far above eve's estimate of
 * every prompt, so only a provider rejection compacts.
 */
async function runTurnWith(
  stepModel: MockLanguageModelV3,
  {
    history = [
      { content: "Please prepare the quarterly report.", kind: "user", role: "user" },
      { content: "I gathered the sales figures.", role: "assistant" },
    ],
    steering,
  }: {
    readonly history?: HarnessSession["history"];
    /** Steers while the summary call is in flight. */
    readonly steering?: AbortController;
  } = {},
) {
  const summaryModel = new MockLanguageModelV3({
    doStream: async () => {
      steering?.abort();
      return summaryStream();
    },
  });
  const fetchReport = vi.fn(async () => ({ figures: REPORT_FIGURES }));
  const events: UnstampedMessageStreamEvent[] = [];
  const session: HarnessSession = {
    agent: {
      compactionModelReference: { id: "summary-model" },
      modelReference: { id: "step-model" },
      system: "You help Alice.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:overflow-session",
    history,
    sessionId: "overflow-session",
  };
  const harness = createToolLoopHarness({
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async (reference) =>
      reference.id === "summary-model" ? summaryModel : stepModel,
    steeringSignal: steering?.signal,
    tools: new Map([
      [
        "fetch_report",
        {
          description: "Fetch the quarterly figures.",
          execute: fetchReport,
          inputSchema: jsonSchema({ additionalProperties: false, properties: {}, type: "object" }),
          name: "fetch_report",
        },
      ],
    ]),
  });
  let result = await harness(session, { message: "Now draft the outline." });
  // A steered step hands back to the caller, which reruns it with the steering message.
  while (typeof result.next === "function" && result.steered !== true) {
    result = await result.next(result.session);
  }
  return { events, fetchReport, result, summaryCalls: summaryModel.doStreamCalls.length };
}

const ofType = (events: readonly UnstampedMessageStreamEvent[], type: string) =>
  events.filter((event) => event.type === type);

/** Prior turns in Japanese, which eve's character estimate undercounts about fourfold. */
const japaneseHistory: HarnessSession["history"] = [
  { content: "四半期報告書を準備してください。", kind: "user", role: "user" },
  { content: "地域別の売上高と製品別の利益率をまとめました。".repeat(2_500), role: "assistant" },
];

describe("context-overflow recovery", () => {
  it("caps a large tool result from this turn and keeps the call it answered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockImplementationOnce(async () => reportCallStream())
      .mockRejectedValueOnce(anthropicOverflowError(130_000, 120_000))
      .mockImplementation(async () => answerStream());

    const { events, fetchReport, result, summaryCalls } = await runTurnWith(
      new MockLanguageModelV3({ doStream }),
    );

    expect(doStream).toHaveBeenCalledTimes(3);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    // Capping the result was enough, so nothing was summarized.
    expect(summaryCalls).toBe(0);
    expect(result.settledTurn).toEqual({ output: "Here is the report outline." });
    const retryPrompt = JSON.stringify(doStream.mock.calls[2]![0].prompt);
    expect(retryPrompt).toContain("call_report");
    expect(retryPrompt).toContain("Truncated by eve");
    expect(retryPrompt).toContain("I gathered the sales figures.");
    expect(retryPrompt).toContain("Do not repeat writes");
    expect(retryPrompt.length).toBeLessThan(REPORT_FIGURES.length);
    expect(ofType(events, "compaction.requested")).toHaveLength(1);
    expect(ofType(events, "compaction.completed")).toHaveLength(1);
    expect(ofType(events, "step.failed")).toHaveLength(0);
  });

  it("summarizes text the estimate undercounted, sized by the provider's count", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockRejectedValueOnce(anthropicOverflowError(70_000, 60_000))
      .mockImplementation(async () => answerStream());

    const { events, result, summaryCalls } = await runTurnWith(
      new MockLanguageModelV3({ doStream }),
      { history: japaneseHistory },
    );

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(summaryCalls).toBe(1);
    expect(result.settledTurn).toEqual({ output: "Here is the report outline." });
    const retryPrompt = JSON.stringify(doStream.mock.calls[1]![0].prompt);
    expect(retryPrompt).toContain("Alice asked for the quarterly report.");
    expect(retryPrompt).toContain("Now draft the outline.");
    expect(retryPrompt).not.toContain("地域別の売上高");
    expect(ofType(events, "compaction.requested")).toHaveLength(1);
    expect(ofType(events, "compaction.completed")).toHaveLength(1);
    expect(ofType(events, "step.started")).toHaveLength(1);
    // The summary call counts toward the turn that needed it.
    expect(getTurnUsageState(result.session.state)?.session).toMatchObject({
      inputTokens: 160,
      outputTokens: 14,
    });
  });

  it("restarts the step when steering lands during the compaction", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockRejectedValueOnce(anthropicOverflowError(70_000, 60_000))
      .mockImplementation(async () => answerStream());

    const { events, result, summaryCalls } = await runTurnWith(
      new MockLanguageModelV3({ doStream }),
      { history: japaneseHistory, steering: new AbortController() },
    );

    expect(summaryCalls).toBe(1);
    expect(result.steered).toBe(true);
    expect(ofType(events, "step.failed")).toHaveLength(0);
  });

  it("fails the step after one compaction when the retry overflows too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn<MockLanguageModelV3["doStream"]>(async () => {
      throw anthropicOverflowError(70_000, 60_000);
    });

    const { events, summaryCalls } = await runTurnWith(new MockLanguageModelV3({ doStream }), {
      history: japaneseHistory,
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(summaryCalls).toBe(1);
    expect(ofType(events, "compaction.requested")).toHaveLength(1);
    expect(ofType(events, "compaction.completed")).toHaveLength(1);
    expect(ofType(events, "step.failed")).toHaveLength(1);
    // A rejected 4xx stays terminal, as before recovery existed.
    expect(ofType(events, "session.failed")).toHaveLength(1);
  });
});
