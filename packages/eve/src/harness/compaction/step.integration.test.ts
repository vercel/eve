import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { forgetSessionLive, readDefinitionsState } from "#definitions/state.js";
import { evaluateValues } from "#definitions/step.js";
import type { DynamicContext } from "#dynamic/definition.js";
import * as compaction from "#harness/compaction/engine.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { eventsOf } from "#harness/publication.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession, HarnessToolMap, StepFn } from "#harness/types.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { CompactionOverflowError, fixedTail, turns } from "#public/compaction/index.js";
import type {
  CompactionContext,
  CompactionMeasure,
  CompactionStrategy,
} from "#shared/compaction-strategy.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";
import type { PublicAgentDynamicModelDefinition } from "#shared/agent-definition.js";

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

const finish = (unified: "stop" | "tool-calls", inputTokens = 50): StreamPart => ({
  finishReason: { raw: undefined, unified },
  type: "finish",
  usage: {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
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
const lookup = (preamble: string, inputTokens?: number): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "preamble", type: "text-start" },
    { delta: preamble, id: "preamble", type: "text-delta" },
    { id: "preamble", type: "text-end" },
    { input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" },
    finish("tool-calls", inputTokens),
  ]);
const lookupTool: HarnessToolDefinition = {
  description: "Looks up the sources.",
  execute: async () => "Two cases.",
  inputSchema: jsonSchema({ type: "object" }),
  name: "lookup",
};
const policyTool: HarnessToolDefinition = {
  ...lookupTool,
  description: "Protected policy. ".repeat(1_200),
};
const overThresholdAgent = {
  model: { contextWindowTokens: 20_000, id: "step-model" },
  thresholdPercent: 0.25,
};

async function untilTurnEnds(kernel: StepFn, session: HarnessSession, message: string) {
  let stepped = await kernel(session, { message });
  while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  return stepped;
}

function userTexts(prompt: Prompt): string[] {
  return prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}

async function compactWith(
  model: MockLanguageModelV3,
  handleEvent: (events: readonly SessionEvent[]) => Promise<void> = async () => {},
  compactionStrategy?: CompactionStrategy,
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
    agent: { compactionStrategy, model: { id: "summary-model" } },
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
    const owners = events.flatMap((event) =>
      event.type === "model.requested" ? [event.data.owner] : [],
    );
    expect(owners.every((owner) => !("changeId" in owner))).toBe(true);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "failed" },
    });
    expect(result.next).toBeNull();
  });

  it("keeps summary usage after a late compaction failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Summary validation failed.");
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
    const result = await createTestKernel({
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

    expect(sessionUsage(result.session)).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    expect(result.next).toBeNull();
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: error.message } },
    });
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(doStream).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { outcome: "failed" } },
    ]);
    expect(events.filter((event) => event.type === "usage.recorded")).toMatchObject([
      { data: { usage: { inputTokens: 120, outputTokens: 8 } } },
    ]);
  });

  it("compacts against the model's window when the agent alone is over the threshold", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const summaries = vi.fn(async () => summaryStream());
    const turnPrompts: Prompt[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (system.includes("CONTEXT CHECKPOINT COMPACTION")) return await summaries();
        turnPrompts.push(prompt);
        return turnPrompts.length === 1 ? lookup("Let me check.", 12_000) : answer();
      },
    });
    const events: SessionEvent[] = [];
    const notes = "Earlier notes. ".repeat(4_000);

    const result = await untilTurnEnds(
      createTestKernel({
        agent: overThresholdAgent,
        handleEvent: async (publication) => void events.push(...eventsOf(publication)),
        resolveModel: async () => model,
        tools: new Map([["lookup", policyTool]]),
      }),
      {
        compaction: {},
        continuationToken: "http:agent-over-threshold",
        history: [
          { content: notes, kind: "user", role: "user" },
          { content: "Noted.", role: "assistant" },
        ],
        sessionId: "agent-over-threshold",
      },
      "Which sources back the second claim?",
    );

    expect(summaries).toHaveBeenCalledOnce();
    expect(turnPrompts).toHaveLength(2);
    for (const prompt of turnPrompts) {
      expect(JSON.stringify(prompt)).toContain("Alice asked for the quarterly report.");
      expect(JSON.stringify(prompt)).not.toContain("Earlier notes. Earlier notes.");
      expect(prompt).toContainEqual({
        content: [{ text: "Noted.", type: "text" }],
        role: "assistant",
      });
    }
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "completed" },
    });
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(result.next).toBeNull();
  });

  it("fails only the turn when the provider still rejects the request as too long after compacting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summaries = vi.fn(async () => summaryStream());
    let turnCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (system.includes("CONTEXT CHECKPOINT COMPACTION")) return await summaries();
        turnCalls += 1;
        throw new APICallError({
          isRetryable: false,
          message: "prompt is too long: 21000 tokens > 20000 maximum",
          requestBodyValues: {},
          statusCode: 400,
          url: "https://provider.example/v1/messages",
        });
      },
    });
    const events: SessionEvent[] = [];
    const kernel = createTestKernel({
      agent: overThresholdAgent,
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async () => model,
      tools: new Map([["lookup", policyTool]]),
    });

    const rejected = await untilTurnEnds(
      kernel,
      {
        compaction: {},
        continuationToken: "http:provider-too-long",
        history: [],
        sessionId: "provider-too-long",
      },
      "Please review Alice's contract.",
    );
    const followUp = await untilTurnEnds(kernel, rejected.session, "Please list its parties.");

    expect(summaries).toHaveBeenCalledTimes(2);
    expect(turnCalls).toBe(4);
    expect(rejected.next).toBeNull();
    expect(followUp.next).toBeNull();
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      {
        data: {
          outcome: "failed",
          error: {
            code: "MODEL_CALL_FAILED",
            message: "The request exceeds the model's context window.",
          },
        },
      },
      { data: { outcome: "failed" } },
    ]);
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
  });

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

  it("fails only the turn when protected request context alone exceeds the model's window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => answer());
    const events: SessionEvent[] = [];
    const result = await createTestKernel({
      agent: { model: { contextWindowTokens: 2_000, id: "summary-model" }, thresholdPercent: 0.5 },
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async () => new MockLanguageModelV3({ doStream }),
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
        continuationToken: "http:fixed-part-over-window",
        history: [],
        sessionId: "fixed-part-over-window",
      },
      { message: "Please continue." },
    );

    expect(doStream).not.toHaveBeenCalled();
    expect(events.some((event) => event.type.startsWith("context."))).toBe(false);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: {
        outcome: "failed",
        error: {
          code: "COMPACTION_FAILED",
          message: expect.stringContaining("~2000-token context window"),
        },
      },
    });
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(result.next).toBeNull();
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

    const result = await compactWith(model, undefined, undefined, measurement);

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

  it("announces the catalog again on the next turn when a turn-end strategy dropped it", async () => {
    const requests: string[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (system.includes("CONTEXT CHECKPOINT COMPACTION")) return summaryStream();
        requests.push(userTexts(prompt));
        return answer();
      },
    });
    const dropsAnnouncements: CompactionStrategy = {
      compact: async (history, ctx) => {
        const summary = await ctx.summarize(history);
        return [
          ...ctx.checkpoint(summary),
          ...history.filter((m) => m.role === "user" && m.kind === "user").slice(-1),
        ];
      },
      when: { "turn.settled": () => true },
    };
    const tools: HarnessToolMap = new Map([
      ["lookup", lookupTool],
      ["refund_invoice", { ...lookupTool, deferred: true, name: "refund_invoice" }],
    ]);

    await contextStorage.run(new ContextContainer(), async () => {
      const kernel = createTestKernel({
        agent: {
          compactionStrategy: dropsAnnouncements,
          model: { contextWindowTokens: 20_000, id: "step-model" },
        },
        handleEvent: foldingHandler(),
        resolveModel: async () => model,
        tools,
      });
      const first = await untilTurnEnds(
        kernel,
        {
          compaction: {},
          continuationToken: "http:announcement-turn-end",
          history: [],
          sessionId: "announcement-turn-end",
        },
        "Which sources back the first claim?",
      );
      expect(JSON.stringify(first.session.history)).not.toContain("eve__search");
      await untilTurnEnds(kernel, first.session, "And the second?");
    });

    const catalog = expect.stringContaining("eve__search");
    expect(requests).toEqual([
      [catalog, "Which sources back the first claim?"],
      [
        "Summary of our conversation so far:",
        "Which sources back the first claim?",
        catalog,
        "And the second?",
      ],
    ]);
  });
});

function dynamicModelAgent(input: {
  readonly compactionModel?: { readonly id: string };
  readonly dynamicTool?: (ctx: DynamicContext) => unknown;
  readonly model: PublicAgentDynamicModelDefinition;
}): SessionAgent {
  const sourceId = "agent.ts";
  return fromCompiledBundle({
    graph: { nodesByNodeId: new Map() },
    modelMetadata: async () => ({}),
    moduleMap: {
      nodes: {
        root: {
          modules: {
            [sourceId]: {
              default: defineAgent({ model: input.model } as never),
            },
          },
        },
      },
    },
    nodeId: "root",
    resolvedAgent: {
      config: {},
      definitions:
        input.dynamicTool === undefined
          ? []
          : [
              {
                evaluate: input.dynamicTool,
                kind: "tool",
                logicalPath: "tools/unused.ts",
                slug: "unused",
                sourceId: "tools/unused.ts",
              },
            ],
      instructions: [],
      skills: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {
      compactionModel: input.compactionModel,
      dynamicModel: { exportName: "default", logicalPath: sourceId, sourceId },
      id: "agent",
    },
  } as never);
}

const COMPACT_HISTORY: HarnessModelMessage[] = [
  { content: "Please prepare the quarterly report.", kind: "user", role: "user" },
  { content: "I started the report.", role: "assistant" },
  { content: "Thanks, keep going.", kind: "user", role: "user" },
];

describe("between-turn compaction with dynamic models", () => {
  it("evaluates a dynamic model with no persisted slot and leaves unrelated dynamic definitions unevaluated", async () => {
    const modelEvaluations: number[] = [];
    const dynamicTool = vi.fn(() => null);
    const model = new MockLanguageModelV3({ doStream: async () => summaryStream() });
    const events: SessionEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "dynamic-compact-fresh");
    ctx.set(
      SessionAgentKey,
      dynamicModelAgent({
        dynamicTool,
        model: defineDynamicModel(async (evalCtx) => {
          modelEvaluations.push((await evalCtx.messages()).length);
          return { model: "openai/dynamic-model", modelContextWindowTokens: 20_000 };
        }),
      }),
    );

    const result = await contextStorage.run(ctx, () =>
      createTestKernel({
        agent: { model: { id: "unused-static" } },
        compactOnly: true,
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel: async (reference) => {
          expect(reference.id).toBe("openai/dynamic-model");
          return model;
        },
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: "http:dynamic-compact-fresh",
          history: COMPACT_HISTORY,
          sessionId: "dynamic-compact-fresh",
        },
        {},
      ),
    );

    expect(modelEvaluations).toEqual([COMPACT_HISTORY.length]);
    expect(dynamicTool).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(events.filter((event) => event.type === "delivery.settled")).toMatchObject([
      { data: { outcome: "applied" } },
    ]);
    expect(result.session.history).toContainEqual({
      content: "Alice asked for the quarterly report.",
      role: "assistant",
    });
    expect(readDefinitionsState(ctx).slots["model:agent"]).toMatchObject({
      value: { reference: { contextWindowTokens: 20_000, id: "openai/dynamic-model" } },
    });
  });

  it("re-evaluates a cold live dynamic model with conversation history", async () => {
    const seenMessages: number[] = [];
    const liveModel = markMockModel(
      new MockLanguageModelV4({
        doStream: async () => textStreamResult("Cold live summary."),
        modelId: "live-model",
        provider: "eve-test",
      }),
    );
    const ctx = new ContextContainer();
    const sessionId = "dynamic-compact-cold-live";
    ctx.set(SessionIdKey, sessionId);
    enterSessionProjection(ctx, undefined);
    ctx.set(
      SessionAgentKey,
      dynamicModelAgent({
        model: defineDynamicModel(async (evalCtx) => {
          seenMessages.push((await evalCtx.messages()).length);
          return { model: liveModel, modelContextWindowTokens: 20_000 };
        }),
      }),
    );
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: COMPACT_HISTORY }));
    expect(readDefinitionsState(ctx).slots["model:agent"]?.live).toBe(true);

    forgetSessionLive(sessionId);
    const resolveModel = vi.fn(async () => {
      throw new Error("resolveModel should not be called for a live dynamic model");
    });
    const events: SessionEvent[] = [];
    const result = await contextStorage.run(ctx, () =>
      createTestKernel({
        agent: { model: { id: "unused-static" } },
        compactOnly: true,
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel,
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: `http:${sessionId}`,
          history: COMPACT_HISTORY,
          sessionId,
        },
        {},
      ),
    );

    expect(resolveModel).not.toHaveBeenCalled();
    expect(seenMessages).toEqual([COMPACT_HISTORY.length, COMPACT_HISTORY.length]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(result.session.history).toContainEqual({
      content: "Cold live summary.",
      role: "assistant",
    });
  });

  it("uses compaction.model for summarization while still resolving the dynamic turn model", async () => {
    const turnStream = vi.fn(async () => summaryStream());
    const compactionStream = vi.fn(async () => summaryStream());
    const turnModel = new MockLanguageModelV3({
      doStream: turnStream,
      modelId: "turn-model",
      provider: "openai",
    });
    const compactionModel = new MockLanguageModelV3({
      doStream: compactionStream,
      modelId: "compaction-model",
      provider: "anthropic",
    });
    const events: SessionEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "dynamic-compact-override");
    ctx.set(
      SessionAgentKey,
      dynamicModelAgent({
        compactionModel: { id: "anthropic/compaction-model" },
        model: defineDynamicModel(() => ({
          model: "openai/turn-model",
          modelContextWindowTokens: 20_000,
        })),
      }),
    );

    await contextStorage.run(ctx, () =>
      createTestKernel({
        agent: { model: { id: "unused-static" } },
        compactOnly: true,
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel: async (reference) =>
          reference.id === "anthropic/compaction-model" ? compactionModel : turnModel,
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: "http:dynamic-compact-override",
          history: COMPACT_HISTORY,
          sessionId: "dynamic-compact-override",
        },
        {},
      ),
    );

    expect(turnStream).not.toHaveBeenCalled();
    expect(compactionStream).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "model.started")).toMatchObject([
      { data: { modelId: "anthropic/compaction-model" } },
    ]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
  });

  it("settles the compact delivery as failed when the dynamic model throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const choose = vi.fn(() => {
      throw new Error("Dynamic model router unavailable.");
    });
    const events: SessionEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "dynamic-compact-error");
    ctx.set(
      SessionAgentKey,
      dynamicModelAgent({
        model: defineDynamicModel(choose),
      }),
    );

    const result = await contextStorage.run(ctx, () =>
      createTestKernel({
        agent: { model: { id: "unused-static" } },
        compactOnly: true,
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel: async () =>
          new MockLanguageModelV3({ doStream: async () => summaryStream() }),
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: "http:dynamic-compact-error",
          history: COMPACT_HISTORY,
          sessionId: "dynamic-compact-error",
        },
        {},
      ),
    );

    expect(choose).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "delivery.settled")).toMatchObject([
      { data: { outcome: "failed", reason: "compaction-failed" } },
    ]);
    expect(events.some((event) => event.type.startsWith("context."))).toBe(false);
    expect(result.session.history).toEqual(COMPACT_HISTORY);
  });
});

describe("an authored compaction strategy", () => {
  function checkedEvents(input: { readonly started: boolean } = { started: true }) {
    const events: SessionEvent[] = [];
    const issues: unknown[] = [];
    const checker = createStreamChecker();
    const at = "2026-10-28T00:00:00.000Z";
    if (input.started) checker.check({ at, facts: [{ type: "session.started", data: {} }] }, 0);
    let position = input.started ? 1 : 0;
    const handle = async (facts: readonly SessionEvent[]) => {
      events.push(...facts);
      issues.push(...checker.check({ at, facts }, position++));
    };
    return { events, handle, issues };
  }

  it("rewrites the history with its own summary, billed to the change's summary run", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt[0]?.role === "system" ? prompt[0].content : "");
        return summaryStream();
      },
    });
    const seen: string[] = [];
    const strategy: CompactionStrategy = async (history, ctx) => {
      seen.push(ctx.reason);
      const kept = turns(history);
      const summary = await ctx.summarize(kept.slice(0, -1).flat(), {
        instructions: "Name the report Alice asked for.",
      });
      return [...ctx.checkpoint(summary), ...(kept.at(-1) ?? [])];
    };
    const { events, handle, issues } = checkedEvents();

    const result = await compactWith(model, handle, strategy);

    expect(seen).toEqual(["manual"]);
    expect(prompts).toEqual([expect.stringContaining("Name the report Alice asked for.")]);
    expect(result.session.history).toEqual([
      expect.objectContaining({ kind: "context.compaction", role: "user" }),
      { content: "Alice asked for the quarterly report.", role: "assistant" },
      { content: "Thanks, keep going.", kind: "user", role: "user" },
    ]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(sessionUsage(result.session)).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    expect(issues).toEqual([]);
  });

  it("runs eve's default when wrapped in fixedTail()", async () => {
    const model = new MockLanguageModelV3({ doStream: async () => summaryStream() });

    const result = await compactWith(model, async () => {}, fixedTail());

    expect(result.session.history).toContainEqual({
      content: "Alice asked for the quarterly report.",
      role: "assistant",
    });
  });

  it("fails the change and keeps the history when the result drops a call's result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV3({ doStream: async () => summaryStream() });
    const strategy: CompactionStrategy = () => [
      {
        content: [{ input: {}, toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" }],
        role: "assistant",
      },
    ];
    const { events, handle, issues } = checkedEvents();

    const result = await compactWith(model, handle, strategy);

    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      {
        data: {
          error: { message: expect.stringContaining("but not its result") },
          outcome: "failed",
        },
      },
    ]);
    expect(result.session.history).toHaveLength(3);
    expect(issues).toEqual([]);
  });

  it("fails the change when the strategy rewrites what it returned once asked again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV3({ doStream: async () => summaryStream() });
    const strategy: CompactionStrategy = {
      compact: (history) => [
        { content: "Alice asked for the report.", kind: "context.compaction", role: "user" },
        ...history,
      ],
      when: { "model.requested": () => true },
    };
    const { events, handle, issues } = checkedEvents();

    const result = await compactWith(model, handle, strategy);

    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      {
        data: {
          error: { message: expect.stringContaining("changes what it returned when asked again") },
          outcome: "failed",
        },
      },
    ]);
    expect(result.session.history).toHaveLength(3);
    expect(issues).toEqual([]);
  });

  it("fails the turn before the model call when an automatic result doesn't fit the window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) =>
        userTexts(prompt).length === 1
          ? lookup(`Let me check. ${"lorem ipsum ".repeat(1_500)}`)
          : answer(),
    });
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "http:authored-overflow-session",
      history: [],
      sessionId: "authored-overflow-session",
    };
    const reasons: string[] = [];
    const dropQuestion: CompactionStrategy = (history, ctx) => {
      reasons.push(ctx.reason);
      return history.slice(1);
    };
    const events: SessionEvent[] = [];

    await contextStorage.run(new ContextContainer(), async () => {
      const fold = foldingHandler();
      let stepped = await createTestKernel({
        agent: {
          compactionStrategy: dropQuestion,
          instructions: "You help Alice.",
          model: { contextWindowTokens: 2_500, id: "step-model" },
          thresholdPercent: 0.8,
        },
        handleEvent: async (publication, messages) => {
          events.push(...eventsOf(publication));
          await fold(publication, messages);
        },
        resolveModel: async () => model,
        tools: new Map([["lookup", lookupTool]]),
      })(session, { message: "Which sources back the second claim?" });
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
    });

    expect(reasons).toEqual(["automatic"]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { error: { message: expect.stringContaining("the limit is") }, outcome: "failed" } },
    ]);
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      data: {
        error: { code: "COMPACTION_FAILED", message: expect.stringContaining("the limit is") },
        outcome: "failed",
      },
      type: "turn.settled",
    });
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
  });
  async function runTurn(
    strategy: CompactionStrategy,
    respond: (prompt: Prompt) => StreamResult,
    modelReference: RuntimeModelReference = { contextWindowTokens: 4_000, id: "step-model" },
    system = "You help Alice.",
  ) {
    const requests: Parameters<MockLanguageModelV3["doStream"]>[0][] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        requests.push(options);
        return respond(options.prompt);
      },
    });
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "http:authored-trigger-session",
      history: [],
      sessionId: "authored-trigger-session",
    };
    const { events, handle, issues } = checkedEvents({ started: false });
    let stepped: Awaited<ReturnType<StepFn>> | undefined;
    await contextStorage.run(new ContextContainer(), async () => {
      const fold = foldingHandler();
      stepped = await createTestKernel({
        agent: {
          compactionStrategy: strategy,
          instructions: system,
          model: modelReference,
          thresholdPercent: 2_000 / (modelReference.contextWindowTokens ?? 4_000),
        },
        handleEvent: async (publication, messages) => {
          await handle(eventsOf(publication));
          await fold(publication, messages);
        },
        resolveModel: async () => model,
        tools: new Map([["lookup", lookupTool]]),
      })(session, { message: "Which sources back the second claim?" });
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
    });
    return { events, issues, requests, session: stepped!.session };
  }

  const SUMMARY_PROMPT = "Write a handoff summary for the next model.";
  const isSummaryRequest = (prompt: Prompt) => userTexts(prompt).at(-1) === SUMMARY_PROMPT;

  it("runs at turn end when its trigger asks there, after the answer and before the turn settles", async () => {
    const measures: unknown[] = [];
    const tagged = (event: string, measure: CompactionMeasure) => ({ ...measure, event });
    const firedAt: CompactionContext["event"][] = [];
    const strategy: CompactionStrategy = {
      compact: async (history, ctx) => {
        firedAt.push(ctx.event);
        const summary = await ctx.summarize(history, { prompt: SUMMARY_PROMPT });
        const asked = history.filter(
          (message) => message.role === "user" && (message as { kind?: string }).kind === "user",
        );
        return [...ctx.checkpoint(summary), ...asked];
      },
      when: {
        "model.requested": (measure) => {
          measures.push(tagged("model.requested", measure));
          return false;
        },
        "turn.settled": (measure) => {
          measures.push(tagged("turn.settled", measure));
          return true;
        },
      },
    };

    const { events, issues, requests, session } = await runTurn(strategy, (prompt) =>
      isSummaryRequest(prompt)
        ? summaryStream()
        : userTexts(prompt).length === 1 && !prompt.some((m) => m.role === "tool")
          ? lookup("Let me check.")
          : answer(),
    );

    expect(firedAt).toEqual(["turn.settled"]);
    expect(measures).toEqual([
      expect.objectContaining({
        contextWindowTokens: 4_000,
        event: "model.requested",
        threshold: 2_000,
      }),
      expect.objectContaining({ event: "model.requested" }),
      expect.objectContaining({ event: "turn.settled" }),
      expect.objectContaining({ event: "model.requested" }),
    ]);
    const summaryRequest = requests.find((request) => isSummaryRequest(request.prompt))!;
    expect(summaryRequest.prompt[0]).toEqual({
      content: expect.stringContaining("You help Alice."),
      role: "system",
    });
    expect(summaryRequest.tools).toBeUndefined();
    const types = events.map((event) => event.type);
    expect(types.indexOf("context.settled")).toBeLessThan(types.indexOf("turn.settled"));
    expect(types.filter((type) => type === "model.started")).toHaveLength(3);
    expect(session.history).toEqual([
      expect.objectContaining({ kind: "context.compaction", role: "user" }),
      { content: "Alice asked for the quarterly report.", role: "assistant" },
      expect.objectContaining({ content: "Which sources back the second claim?", kind: "user" }),
    ]);
    expect(issues).toEqual([]);
  });

  it("gives its trigger the model's max output when the model metadata has it", async () => {
    const measures: { maxOutputTokens?: number }[] = [];
    const strategy: CompactionStrategy = {
      compact: (history) => [...history],
      when: {
        "model.requested": (measure) => {
          measures.push(measure);
          return false;
        },
      },
    };

    await runTurn(strategy, () => answer(), {
      contextWindowTokens: 4_000,
      id: "step-model",
      maxOutputTokens: 64_000,
    });

    expect(measures.length).toBeGreaterThan(0);
    expect(measures.every((measure) => measure.maxOutputTokens === 64_000)).toBe(true);
  });

  it("keeps the turn's answer when a turn-end compaction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const strategy: CompactionStrategy = {
      compact: () => {
        throw new Error("The notes store is down.");
      },
      when: { "turn.settled": () => true },
    };

    const { events, issues, session } = await runTurn(strategy, () => answer());

    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { error: { message: "The notes store is down." }, outcome: "failed" } },
    ]);
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(session.history.at(-1)).toMatchObject({ role: "assistant" });
    expect(issues).toEqual([]);
  });

  it("sends a custom-prompt summary with the turn's instructions and no tools", async () => {
    let compacted = false;
    const strategy: CompactionStrategy = {
      compact: async (history, ctx) => {
        compacted = true;
        const summary = await ctx.summarize(history, { prompt: SUMMARY_PROMPT });
        return [...ctx.checkpoint(summary), ...history];
      },
      when: { "model.requested": () => !compacted },
    };

    const { requests, session } = await runTurn(strategy, (prompt) =>
      isSummaryRequest(prompt) ? summaryStream() : answer(),
    );

    const [summaryRequest, turnRequest] = requests;
    expect(isSummaryRequest(summaryRequest!.prompt)).toBe(true);
    expect(summaryRequest!.prompt[0]).toEqual(turnRequest!.prompt[0]);
    expect(summaryRequest!.tools).toBeUndefined();
    expect(session.history[0]).toMatchObject({ kind: "context.compaction" });
  });

  it("sends a strategy's own system in place of the agent's instructions", async () => {
    let compacted = false;
    const strategy: CompactionStrategy = {
      compact: async (history, ctx) => {
        compacted = true;
        const summary = await ctx.summarize(history, { prompt: SUMMARY_PROMPT, system: "" });
        return [...ctx.checkpoint(summary), ...history];
      },
      when: { "model.requested": () => !compacted },
    };

    const { requests } = await runTurn(strategy, (prompt) =>
      isSummaryRequest(prompt) ? summaryStream() : answer(),
    );

    const [summaryRequest, turnRequest] = requests;
    expect(turnRequest!.prompt[0]).toMatchObject({ role: "system" });
    expect(summaryRequest!.prompt.some((message) => message.role === "system")).toBe(false);
    expect(summaryRequest!.tools ?? []).toEqual([]);
  });

  it.each([
    ["under", 100],
    ["over", 1_200],
  ])(
    "runs when the request's fixed part is %s eve's threshold and fits the window",
    async (_, repeat) => {
      let compacted = false;
      const strategy: CompactionStrategy = {
        compact: async (history, ctx) => {
          compacted = true;
          expect(ctx.tokens.limit).toBeGreaterThan(0);
          const summary = await ctx.summarize(history, { prompt: SUMMARY_PROMPT, system: "" });
          return [...ctx.checkpoint(summary), ...history];
        },
        when: { "model.requested": () => !compacted },
      };

      const { events, session } = await runTurn(
        strategy,
        (prompt) => (isSummaryRequest(prompt) ? summaryStream() : answer()),
        { contextWindowTokens: 10_000, id: "step-model" },
        `You help Alice. ${"Protected instructions. ".repeat(repeat)}`,
      );

      expect(compacted).toBe(true);
      expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
        { data: { kind: "compaction", outcome: "completed" } },
      ]);
      expect(session.history[0]).toMatchObject({ kind: "context.compaction" });
    },
  );

  it("keeps a summary a strategy places after the messages it keeps", async () => {
    let compacted = false;
    const strategy: CompactionStrategy = {
      compact: (history) => {
        compacted = true;
        return [
          ...history.filter((message) => message.role === "user" && message.kind === "user"),
          { content: "SUMMARY_LAST", kind: "context.compaction", role: "user" },
        ];
      },
      when: { "model.requested": () => !compacted },
    };

    const { issues, session } = await runTurn(strategy, () => answer());

    const kinds = session.history.map((message) =>
      message.role === "user" ? (message as { kind?: string }).kind : message.role,
    );
    expect(kinds).toEqual(["user", "context.compaction", "assistant"]);
    expect(session.history[1]).toMatchObject({ content: "SUMMARY_LAST" });
    expect(issues).toEqual([]);
  });
});

describe("a request over the model's context window", () => {
  const overflow = () =>
    new APICallError({
      isRetryable: false,
      message: "prompt is too long: 208310 tokens > 200000 maximum",
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: {
          message: "prompt is too long: 208310 tokens > 200000 maximum",
          type: "invalid_request_error",
        },
        type: "error",
      }),
      statusCode: 400,
      url: "https://provider.example/v1/messages",
    });
  const history: HarnessModelMessage[] = [
    { content: "Please prepare the quarterly report.", kind: "user", role: "user" },
    { content: "I started the report.", role: "assistant" },
    { content: "Thanks, keep going.", kind: "user", role: "user" },
    { content: "The report is half done.", role: "assistant" },
  ];

  async function runTurn(input: {
    readonly turnCall: () => Promise<StreamResult>;
    readonly summaryCall?: () => Promise<StreamResult>;
    readonly compactionStrategy?: CompactionStrategy;
  }) {
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        return system.includes("You help Alice.")
          ? await input.turnCall()
          : await (input.summaryCall ?? summaryStream)();
      },
    });
    const events: SessionEvent[] = [];
    const result = await contextStorage.run(new ContextContainer(), async () => {
      let stepped = await createTestKernel({
        agent: {
          compactionStrategy: input.compactionStrategy,
          instructions: "You help Alice.",
          model: { contextWindowTokens: 200_000, id: "step-model" },
        },
        handleEvent: foldingHandler(async (event) => void events.push(event)),
        resolveModel: async () => model,
        tools: new Map(),
      })(
        {
          compaction: {},
          continuationToken: "http:overflow",
          history,
          sessionId: "overflow",
        },
        { message: "Is it done yet?" },
      );
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
      return stepped;
    });
    return { events, result };
  }

  it("compacts with reason overflow and retries the step once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const turnCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockRejectedValueOnce(overflow())
      .mockImplementation(async () => answer());
    const summaryCall = vi.fn(async () => summaryStream());

    const { events, result } = await runTurn({ summaryCall, turnCall });

    expect(turnCall).toHaveBeenCalledTimes(2);
    expect(summaryCall).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "completed" },
    });
    expect(result.session.history).toContainEqual({
      content: "Alice asked for the quarterly report.",
      role: "assistant",
    });
  });

  it("passes reason overflow to the agent's strategy, whatever its trigger says", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const strategy: CompactionStrategy = {
      compact: async (messages, ctx) => {
        seen.push(`${ctx.reason} ${ctx.event}`);
        return messages.slice(-1);
      },
      when: { "turn.settled": () => false },
    };
    const turnCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockRejectedValueOnce(overflow())
      .mockImplementation(async () => answer());

    const { events } = await runTurn({ compactionStrategy: strategy, turnCall });

    expect(seen).toEqual(["overflow model.retried"]);
    expect(turnCall).toHaveBeenCalledTimes(2);
    const order = events
      .map((event) => event.type)
      .filter((type) => ["context.started", "model.requested", "model.retried"].includes(type));
    expect(order).toEqual(["model.requested", "model.retried", "context.started"]);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "completed" },
    });
  });

  it("asks the trigger at model.retried when a rate-limited attempt retries in its run", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked: string[] = [];
    const strategy: CompactionStrategy = {
      compact: async (messages) => messages,
      when: {
        "model.requested": () => {
          asked.push("model.requested");
          return false;
        },
        "model.retried": () => {
          asked.push("model.retried");
          return false;
        },
      },
    };
    const turnCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockRejectedValueOnce(
        new APICallError({
          isRetryable: false,
          message: "Too Many Requests",
          requestBodyValues: {},
          statusCode: 429,
          url: "https://provider.example/v1/messages",
        }),
      )
      .mockImplementation(async () => answer());

    const { events } = await runTurn({ compactionStrategy: strategy, turnCall });

    expect(turnCall).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(["model.requested", "model.retried"]);
    expect(
      events
        .map((event) => event.type)
        .filter((type) => ["model.requested", "model.retried"].includes(type)),
    ).toEqual(["model.requested", "model.retried"]);
  });

  it("asks a model.requested trigger once per request when an empty response retries", async () => {
    const seen: string[] = [];
    const strategy: CompactionStrategy = {
      compact: async (messages, ctx) => {
        seen.push(`${ctx.reason} ${ctx.event}`);
        return messages;
      },
      when: { "model.requested": () => true },
    };
    const empty = async (): Promise<StreamResult> => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.close();
        },
      }),
    });
    const turnCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockImplementationOnce(empty)
      .mockImplementation(async () => answer());

    const { events } = await runTurn({ compactionStrategy: strategy, turnCall });

    expect(turnCall).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "model.retried")).toHaveLength(1);
    expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
    expect(seen).toEqual(["automatic model.requested"]);
  });

  it("fails the turn when the retried call overflows again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const turnCall = vi.fn(async (): Promise<StreamResult> => {
      throw overflow();
    });

    const { events } = await runTurn({ turnCall });

    expect(turnCall).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "context.settled")).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('"code":"MODEL_CALL_FAILED"');
    expect(JSON.stringify(events)).toContain("The request exceeds the model's context window.");
  });

  it("rejects summarize() with CompactionOverflowError, so a strategy can shrink and retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const errors: unknown[] = [];
    const strategy: CompactionStrategy = async (messages, ctx) => {
      let older = messages.slice(0, -1);
      for (;;) {
        try {
          return [...ctx.checkpoint(await ctx.summarize(older)), ...messages.slice(-1)];
        } catch (error) {
          errors.push(error);
          if (!(error instanceof CompactionOverflowError)) throw error;
          older = older.slice(1);
        }
      }
    };
    const summaryCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockRejectedValueOnce(overflow())
      .mockImplementation(async () => summaryStream());
    const turnCall = vi
      .fn<() => Promise<StreamResult>>()
      .mockRejectedValueOnce(overflow())
      .mockImplementation(async () => answer());

    const { events } = await runTurn({ compactionStrategy: strategy, summaryCall, turnCall });

    expect(errors).toEqual([expect.any(CompactionOverflowError)]);
    expect(summaryCall).toHaveBeenCalledTimes(2);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "completed" },
    });
  });
});
