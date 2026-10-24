import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import { eventsOf } from "#harness/publication.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";

// The harness runs outside a workflow body here, where run attributes cannot be written.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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
async function compactWith(
  model: MockLanguageModelV3,
  handleEvent: (events: readonly SessionEvent[]) => Promise<void> = async () => {},
) {
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
    handleEvent: (publication) => handleEvent(eventsOf(publication)),
    resolveModel: async () => model,
    tools: new Map(),
  })(session, {});
}

const replyStream = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { id: "reply", type: "text-start" },
    { delta: "Here is the report.", id: "reply", type: "text-delta" },
    { id: "reply", type: "text-end" },
    {
      finishReason: { raw: undefined, unified: "stop" },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 300, total: 300 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
    },
  ]);

const failedSummaryStream = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error("The summary request is invalid.") },
  ]);

const isSummaryPrompt = (prompt: unknown) =>
  JSON.stringify(prompt).includes("CONTEXT CHECKPOINT COMPACTION");

/** Runs Alice's next turn over a long conversation that no longer fits the threshold. */
async function runLongTurn(summary: () => StreamResult) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return isSummaryPrompt(prompt) ? summary() : replyStream();
    },
  });
  const notes = (label: string) => `${label}: ${"quarterly figures and notes ".repeat(80)}`;
  const session: HarnessSession = {
    agent: { modelReference: { id: "turn-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 2, threshold: 1_500 },
    continuationToken: "http:turn-compaction",
    history: [
      { content: notes("January"), kind: "user", role: "user" },
      { content: notes("February"), role: "assistant" },
      { content: notes("March"), kind: "user", role: "user" },
      { content: "Noted.", role: "assistant" },
    ],
    sessionId: "turn-compaction",
  };
  const events: SessionEvent[] = [];
  const run = createToolLoopHarness({
    handleEvent: async (publication) => {
      events.push(...eventsOf(publication));
    },
    resolveModel: async () => model,
    tools: new Map(),
  });
  const result = run(session, { message: "Alice asks for the quarterly report." });
  return { events, prompts, result };
}

const lifecycleOf = (events: readonly SessionEvent[]) =>
  events.flatMap(({ data, type }) =>
    type.startsWith("context.") || type.startsWith("model.")
      ? [{ type, ...("outcome" in data && { outcome: data.outcome }) }]
      : [],
  );

describe("compaction before a turn's model call", () => {
  it("summarizes a prompt over the threshold, and the model reads the summary", async () => {
    const { events, prompts, result } = await runLongTurn(summaryStream);
    await result;

    expect(lifecycleOf(events)).toEqual([
      { type: "model.requested" },
      { type: "context.started" },
      { type: "model.requested" },
      { type: "model.started" },
      { outcome: "completed", type: "model.settled" },
      { outcome: "completed", type: "context.settled" },
      { type: "model.started" },
      { outcome: "completed", type: "model.settled" },
    ]);
    expect(events.find((event) => event.type === "context.started")?.data).toMatchObject({
      kind: "compaction",
      trigger: { inputTokens: expect.any(Number) },
      turnId: "turn_0",
    });
    const turnPrompt = JSON.stringify(prompts.at(-1));
    expect(turnPrompt).toContain("Alice asked for the quarterly report.");
    expect(turnPrompt).not.toContain("January");
  });

  it("fails the step without calling the model when the summary fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { events, prompts, result } = await runLongTurn(failedSummaryStream);

    await expect(result).rejects.toThrow("The summary request is invalid.");
    expect(prompts.filter((prompt) => !isSummaryPrompt(prompt))).toEqual([]);
    expect(lifecycleOf(events).slice(-2)).toEqual([
      { outcome: "failed", type: "model.settled" },
      { outcome: "failed", type: "context.settled" },
    ]);
  });
});

describe("compaction summary call", () => {
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

  it("starts no summary run when capping tool output is enough", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamOf([
          { type: "stream-start", warnings: [] },
          { id: "reply", type: "text-start" },
          { delta: "Here is the report.", id: "reply", type: "text-delta" },
          { id: "reply", type: "text-end" },
          {
            finishReason: { raw: undefined, unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
              outputTokens: { reasoning: 0, text: 4, total: 4 },
            },
          },
        ]),
    });
    const events: SessionEvent[] = [];
    const checker = createStreamChecker();
    const at = "2026-10-21T00:00:00.000Z";
    const issues: unknown[] = [];
    let position = 0;
    // Over the threshold, but capping the old search output fits it without a summary.
    const session: HarnessSession = {
      agent: { modelReference: { id: "turn-model" }, system: "You help Alice.", tools: [] },
      compaction: { recentWindowSize: 1, threshold: 20_000 },
      continuationToken: "http:compaction-capped",
      history: [
        { content: "Please search the backlog.", kind: "user", role: "user" },
        {
          content: [{ input: {}, toolCallId: "call-0", toolName: "search", type: "tool-call" }],
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "text", value: "x".repeat(100_000) },
              toolCallId: "call-0",
              toolName: "search",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      sessionId: "compaction-capped",
    };
    await createToolLoopHarness({
      handleEvent: async (publication) => {
        const facts = eventsOf(publication);
        events.push(...facts);
        issues.push(...checker.check({ at, facts }, position++));
      },
      resolveModel: async () => model,
      tools: new Map(),
    })(session, { message: "Alice asks for the quarterly report." });

    expect(
      events
        .filter((event) => event.type.startsWith("context."))
        .map(({ data, type }) => ({ type, ...data })),
    ).toMatchObject([
      { kind: "compaction", type: "context.started" },
      { kind: "compaction", outcome: "completed", type: "context.settled" },
    ]);
    // Only the turn's own run: the summary model was never requested.
    expect(
      events.filter((event) => event.type === "model.requested").map(({ data }) => data),
    ).toEqual([expect.not.objectContaining({ changeId: expect.anything() })]);
    expect(events.filter((event) => event.type === "model.settled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "usage.recorded")).toMatchObject([
      { data: { owner: { runId: "run_0" } } },
    ]);
    expect(issues).toEqual([]);
  });
});
