import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import * as compaction from "#harness/compaction/engine.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { eventsOf } from "#harness/publication.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
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

describe("compaction summary call", () => {
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
      const run = createToolLoopHarness({
        handleEvent: async (publication) => void events.push(...eventsOf(publication)),
        resolveModel: async () => new MockLanguageModelV3({ doStream }),
        tools: new Map(),
      })(
        {
          agent: { modelReference: { id: "summary-model" }, system: "You help Alice.", tools: [] },
          compaction: { recentWindowSize: 1, threshold: 2_000 },
          continuationToken: "http:late-compaction-failure",
          history: [{ content: "Earlier notes. ".repeat(2_000), kind: "user", role: "user" }],
          sessionId: "late-compaction-failure",
        },
        { message: "Please continue." },
      );

      if (terminal) {
        const result = await run;
        expect(result.next).toEqual({ done: true, output: "" });
        expect(sessionUsage(result.session)).toMatchObject({ inputTokens: 120, outputTokens: 8 });
        expect(events.at(-1)).toMatchObject({
          type: "session.ended",
          data: { outcome: "failed", error: { code: "COMPACTION_FAILED", message: error.message } },
        });
      } else {
        await expect(run).rejects.toThrow(error.message);
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

  it("ends before summarizing when protected request context alone exceeds the limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => summaryStream());
    const events: SessionEvent[] = [];
    const result = await createToolLoopHarness({
      handleEvent: async (publication) => void events.push(...eventsOf(publication)),
      resolveModel: async () => new MockLanguageModelV3({ doStream }),
      tools: new Map(),
    })(
      {
        agent: {
          modelReference: { id: "summary-model" },
          system: "Protected instructions. ".repeat(1_000),
          tools: [],
        },
        compaction: { recentWindowSize: 1, threshold: 2_000 },
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

describe("announcements after a compaction during a turn", () => {
  it("announces the catalog again before the turn's question, not after it", async () => {
    const question = "Which sources back the second claim?";
    const requests: string[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (!system.includes("You help Alice.")) return summaryStream();
        requests.push(userTexts(prompt));
        // A long first reply pushes the second step over the threshold, so compaction runs
        // between the turn's steps and folds the first announcement into the summary.
        return requests.length === 1
          ? lookup(`Let me check. ${"lorem ipsum ".repeat(1_500)}`)
          : answer();
      },
    });
    const session: HarnessSession = {
      agent: { modelReference: { id: "step-model" }, system: "You help Alice.", tools: [] },
      compaction: { recentWindowSize: 1, threshold: 2_000 },
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
      let stepped = await createToolLoopHarness({
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
