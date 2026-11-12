import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import * as compaction from "#harness/compaction/engine.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { eventsOf } from "#harness/publication.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];

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

const finish = (unified: "stop" | "tool-calls"): StreamPart => ({
  finishReason: { raw: undefined, unified },
  type: "finish",
  usage: {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 50, total: 50 },
    outputTokens: { reasoning: 0, text: 8, total: 8 },
  },
});
const answer = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "reply", type: "text-start" },
    { delta: "The second claim cites two cases.", id: "reply", type: "text-delta" },
    { id: "reply", type: "text-end" },
    finish("stop"),
  ]);
const lookup = (preamble: string): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "preamble", type: "text-start" },
    { delta: preamble, id: "preamble", type: "text-delta" },
    { id: "preamble", type: "text-end" },
    { input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" },
    finish("tool-calls"),
  ]);
const lookupTool: HarnessToolDefinition = {
  description: "Looks up the sources.",
  execute: async () => "Two cases.",
  inputSchema: jsonSchema({ type: "object" }),
  name: "lookup",
};

/** The user-role text of one model request, in order. */
function userTexts(prompt: Prompt): string[] {
  return prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}

/** Manually compacts a short conversation with `model`, as `session.compact()` does. */
async function compactWith(
  model: MockLanguageModelV3,
  handleEvent: (events: readonly SessionEvent[]) => Promise<void> = async () => {},
  measurement: HarnessSession["compaction"] = {},
) {
  const session: HarnessSession = {
    compaction: measurement,
    continuationToken: "http:compaction-session",
    history: [
      { content: "Please prepare the quarterly report.", kind: "user", role: "user" },
      { content: "I started the report.", role: "assistant" },
      { content: "Thanks, keep going.", kind: "user", role: "user" },
    ],
    sessionId: "compaction-session",
  };
  return createTestKernel({
    agent: { model: { id: "summary-model" } },
    compactOnly: true,
    handleEvent: (publication) => handleEvent(eventsOf(publication)),
    resolveModel: async () => model,
    tools: new Map(),
  })(session, {});
}

describe("compaction summary call", () => {
  it("fails the compaction it opened when its summary model doesn't resolve", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const turnModel = new MockLanguageModelV3({ doStream: async () => summaryStream() });
    const events: SessionEvent[] = [];
    const result = await createTestKernel({
      agent: {
        compactionModel: { id: "compaction-model" },
        model: { contextWindowTokens: 2_000, id: "turn-model" },
        thresholdPercent: 1,
      },
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async (reference) => {
        if (reference.id === "compaction-model") throw new Error("Unknown model: compaction-model");
        return turnModel;
      },
      tools: new Map(),
    })(
      {
        // Small enough that the brief compacts before the turn's first model call.
        compaction: {},
        continuationToken: "http:unresolved-compaction-model",
        history: [
          { content: "Alice's brief. ".repeat(2_000), kind: "user", role: "user" },
          { content: "Noted.", role: "assistant" },
        ],
        sessionId: "unresolved-compaction-model",
      },
      { message: "Please continue." },
    );

    const changes = events.filter((event) => event.type.startsWith("context."));
    expect(changes).toMatchObject([
      { type: "context.started", data: { kind: "compaction" } },
      {
        type: "context.settled",
        data: { outcome: "failed", error: { code: "COMPACTION_FAILED" } },
      },
    ]);
    // No summary run started: the only run requested is the turn's own.
    const owners = events.flatMap((event) =>
      event.type === "model.requested" ? [event.data.owner] : [],
    );
    expect(owners.every((owner) => !("changeId" in owner))).toBe(true);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "failed" },
    });
    expect(result.next).toBeNull();
  });

  it.each([
    { error: new CompactionOverLimitError("Still over the limit."), terminal: true },
    { error: new Error("Summary validation failed."), terminal: false },
  ])(
    "keeps summary usage after a late compaction failure ($terminal terminal)",
    async ({ error, terminal }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(compaction, "compactMessages").mockImplementation(
        async (_messages, _config, summarize) => {
          await summarize({
            messages: [{ role: "user", content: "Summarize Alice's research notes." }],
            system: "",
          });
          throw error;
        },
      );
      const doStream = vi.fn(async () => summaryStream());
      const events: SessionEvent[] = [];
      const run = createTestKernel({
        agent: { model: { contextWindowTokens: 2_000, id: "summary-model" }, thresholdPercent: 1 },
        handleEvent: async (publication) => void events.push(...eventsOf(publication)),
        resolveModel: async () => new MockLanguageModelV3({ doStream }),
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: "http:late-compaction-failure",
          history: [{ content: "Earlier notes. ".repeat(2_000), kind: "user", role: "user" }],
          sessionId: "late-compaction-failure",
        },
        { message: "Please continue." },
      );

      const result = await run;
      expect(sessionUsage(result.session)).toMatchObject({ inputTokens: 120, outputTokens: 8 });
      if (terminal) {
        expect(result.next).toEqual({ done: true, output: "" });
        expect(events.at(-1)).toMatchObject({
          type: "session.ended",
          data: { outcome: "failed", error: { code: "COMPACTION_FAILED", message: error.message } },
        });
      } else {
        expect(result.next).toBeNull();
        expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
          data: { outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: error.message } },
        });
        expect(events.some((event) => event.type === "session.ended")).toBe(false);
      }
      expect(doStream).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
        { data: { outcome: "failed" } },
      ]);
      expect(events.filter((event) => event.type === "usage.recorded")).toMatchObject([
        { data: { usage: { inputTokens: 120, outputTokens: 8 } } },
      ]);
    },
  );

  // https://github.com/vercel/eve/issues/5350
  it("fails the turn and keeps the history when the summary call stays rate limited", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const turnCalls = vi.fn(async () => answer());
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (!system.includes("CONTEXT CHECKPOINT COMPACTION")) return await turnCalls();
        throw new APICallError({
          // eve's retry policy still retries the 429; this skips the AI SDK's slower inner retry.
          isRetryable: false,
          message: "Too Many Requests",
          requestBodyValues: {},
          statusCode: 429,
          url: "https://provider.example/v1/messages",
        });
      },
    });
    const history: HarnessModelMessage[] = [
      { content: `Read this brief. ${"lorem ipsum ".repeat(1_500)}`, kind: "user", role: "user" },
      { content: "I read the brief.", role: "assistant" },
    ];
    const events: SessionEvent[] = [];

    const result = await contextStorage.run(new ContextContainer(), async () => {
      let stepped = await createTestKernel({
        agent: { model: { contextWindowTokens: 2_000, id: "step-model" }, thresholdPercent: 1 },
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel: async () => model,
        tools: new Map(),
      })(
        {
          // Small enough that the long brief compacts before the turn's first model call.
          compaction: {},
          continuationToken: "http:rate-limited-compaction",
          history,
          sessionId: "rate-limited-compaction",
        },
        { message: "Which sources back the second claim?" },
      );
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
      return stepped;
    });

    expect(turnCalls).not.toHaveBeenCalled();
    expect(result.next).toBeNull();
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "failed", error: { code: "MODEL_CALL_FAILED" } },
    });
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(result.session.history.slice(0, 2)).toEqual(history);
  });

  it("ends before summarizing when protected request context alone exceeds the limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => summaryStream());
    const events: SessionEvent[] = [];
    const result = await createTestKernel({
      agent: { model: { contextWindowTokens: 2_000, id: "summary-model" }, thresholdPercent: 1 },
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async () => new MockLanguageModelV3({ doStream }),
      // A tool description no compaction can shrink, over the limit by itself.
      tools: new Map([
        [
          "policy_lookup",
          {
            description: "Protected policy. ".repeat(1_000),
            execute: async () => ({}),
            inputSchema: jsonSchema({ type: "object" }),
            name: "policy_lookup",
          },
        ],
      ]),
    })(
      {
        compaction: {},
        continuationToken: "http:fixed-part-over-limit",
        history: [],
        sessionId: "fixed-part-over-limit",
      },
      { message: "Please continue." },
    );

    expect(result.next).toEqual({ done: true, output: "" });
    expect(doStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      data: {
        outcome: "failed",
        error: {
          code: "COMPACTION_FAILED",
          message: expect.stringContaining("system prompt, tools, memory and context"),
        },
      },
    });
  });

  it("settles a failed manual compaction and its summary run exactly once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamOf([
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("The summary request is invalid.") },
        ]),
    });
    const events: SessionEvent[] = [];
    const checker = createStreamChecker();
    const at = "2026-10-21T00:00:00.000Z";
    checker.check({ at, facts: [{ type: "session.started", data: {} }] }, 0);
    const issues: unknown[] = [];
    let position = 1;
    const result = await compactWith(model, async (facts) => {
      events.push(...facts);
      issues.push(...checker.check({ at, facts }, position++));
    });

    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { outcome: "failed" } },
    ]);
    expect(events.filter((event) => event.type === "model.settled")).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(result.session.history).toHaveLength(3);
  });

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
    expect(sessionUsage(result.session)).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
    });
    expect(takeSessionUsageDelta(result.session).delta).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("compacts before switching back when the model's stale measurement undercounts appended JSON", async () => {
    const history: HarnessModelMessage[] = [
      { content: "Alice requested a report.", kind: "user", role: "user" },
      { content: "I will collect the records.", role: "assistant" },
      { content: "Please include Bob's records.", kind: "user", role: "user" },
      { content: "I will include them.", role: "assistant" },
      ...Array.from({ length: 10 }, (_, index): HarnessModelMessage[] => [
        {
          content: [
            { type: "tool-call", toolCallId: `records-${index}`, toolName: "lookup", input: {} },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              type: "tool-result",
              toolCallId: `records-${index}`,
              toolName: "lookup",
              output: { type: "json", value: { records: '{"id":123,"value":456},'.repeat(1_500) } },
            },
          ],
          role: "tool",
        },
      ]).flat(),
    ];
    let measurement = compaction.withPromptMeasurement(
      {},
      {
        inputTokens: 10_000,
        modelId: "model-a",
        promptMessageCount: 4,
      },
    );
    measurement = compaction.withPromptMeasurement(measurement, {
      inputTokens: 185_000,
      modelId: "model-b",
      promptMessageCount: 24,
    });
    expect(estimateTokens(history.slice(4))).toBeGreaterThan(90_000);
    expect(estimateTokens(history.slice(4))).toBeLessThan(110_000);
    const events: SessionEvent[] = [];
    let compactedBeforeCall = false;
    const turnCalls = vi.fn(async () => {
      compactedBeforeCall = events.some(
        (event) => event.type === "context.settled" && event.data.outcome === "completed",
      );
      return answer();
    });
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        return system.includes("CONTEXT CHECKPOINT COMPACTION") ? summaryStream() : turnCalls();
      },
    });

    const result = await createTestKernel({
      agent: { model: { contextWindowTokens: 200_000, id: "model-a" } },
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async () => model,
      tools: new Map([["lookup", lookupTool]]),
    })(
      {
        compaction: measurement,
        continuationToken: "http:stale-model-measurement",
        history,
        sessionId: "stale-model-measurement",
      },
      { message: "Please summarize Alice and Bob's records." },
    );

    const change = events.find((event) => event.type === "context.started");
    expect(change?.data.trigger?.inputTokens).toBeGreaterThanOrEqual(185_000);
    expect(compactedBeforeCall).toBe(true);
    expect(turnCalls).toHaveBeenCalledOnce();
    expect(estimateTokens(result.session.history)).toBeLessThan(estimateTokens(history));
  });

  it("reserves the selected model's envelope when manually compacting after a model switch", async () => {
    const summary = "Alice prepared the quarterly report. ".repeat(2_000);
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamOf([
          { type: "stream-start", warnings: [] },
          { id: "summary", type: "text-start" },
          { delta: summary, id: "summary", type: "text-delta" },
          { id: "summary", type: "text-end" },
          finish("stop"),
        ]),
    });
    let measurement = compaction.withPromptMeasurement(
      {},
      {
        inputTokens: 90_040,
        modelId: "summary-model",
        promptMessageCount: 3,
        requestEnvelopeTokens: 90_000,
      },
    );
    measurement = compaction.withPromptMeasurement(measurement, {
      inputTokens: 41,
      modelId: "other-model",
      promptMessageCount: 3,
      requestEnvelopeTokens: 1,
    });

    const result = await compactWith(model, undefined, measurement);

    expect(result.session.history[1]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(result.session.history)).toContain("Alice prepared");
    expect(estimateTokens(result.session.history)).toBeLessThanOrEqual(10_000);
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
    expect(sessionUsage(result.session)).toMatchObject({ inputTokens: 120 });
  });
});

describe("announcements after a compaction during a turn", () => {
  it("announces the catalog again before the turn's question, not after it", async () => {
    const question = "Which sources back the second claim?";
    const requests: string[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (system.includes("CONTEXT CHECKPOINT COMPACTION")) return summaryStream();
        requests.push(userTexts(prompt));
        // A long first reply pushes the second step over the threshold, so compaction runs
        // between the turn's steps and folds the first announcement into the summary.
        return requests.length === 1
          ? lookup(`Let me check. ${"lorem ipsum ".repeat(1_500)}`)
          : answer();
      },
    });
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "http:announcement-compaction-session",
      history: [],
      sessionId: "announcement-compaction-session",
    };
    const tools: HarnessToolMap = new Map([
      ["lookup", lookupTool],
      // A deferred tool gives the session a catalog to announce.
      ["refund_invoice", { ...lookupTool, deferred: true, name: "refund_invoice" }],
    ]);

    await contextStorage.run(new ContextContainer(), async () => {
      let stepped = await createTestKernel({
        agent: { model: { contextWindowTokens: 2_000, id: "step-model" }, thresholdPercent: 1 },
        handleEvent: foldingHandler(),
        resolveModel: async () => model,
        tools,
      })(session, { message: question });
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
    });

    const catalog = expect.stringContaining("eve__search");
    expect(requests).toEqual([
      [catalog, question],
      ["Summary of our conversation so far:", catalog, question],
    ]);
  });
});
