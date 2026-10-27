import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { readReactionsState, writeReactionsState } from "#reactions/state.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const textStream = (text: string, inputTokens: number): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of [
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: text, id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
            outputTokens: { reasoning: 0, text: 4, total: 4 },
          },
        },
      ] as StreamPart[])
        controller.enqueue(part);
      controller.close();
    },
  }),
});

const isSummaryCall = (prompt: readonly { role: string; content: unknown }[]): boolean =>
  !String(prompt[0]?.content).includes("You help Alice.");

function session(history: HarnessSession["history"], threshold: number): HarnessSession {
  return {
    agent: { modelReference: { id: "turn-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 1, threshold },
    continuationToken: "http:strategy",
    history,
    sessionId: "strategy",
  };
}

async function run(input: {
  readonly ctx?: ContextContainer;
  readonly message: string;
  readonly model: MockLanguageModelV3;
  readonly session: HarnessSession;
  readonly strategy?: CompactionStrategy;
}): Promise<readonly SessionEvent[]> {
  const events: SessionEvent[] = [];
  const handle = foldingHandler();
  await contextStorage.run(input.ctx ?? new ContextContainer(), async () => {
    let stepped = await createToolLoopHarness({
      compactionStrategy: input.strategy,
      handleEvent: async (publication) => {
        events.push(...eventsOf(publication));
        await handle(publication);
      },
      resolveModel: async () => input.model,
      tools: new Map(),
    })(input.session, { message: input.message });
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return events;
}

const contextStarts = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === "context.started");

describe("compaction triggers", () => {
  it("compacts once for a request that alone exceeds the limit, then runs on", async () => {
    let summaries = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        if (isSummaryCall(prompt)) {
          summaries++;
          return textStream("Alice sent a very long document.", 120);
        }
        // The provider counts about 1.6x what the estimate does, close under the limit.
        return textStream("Done.", 19_000);
      },
    });

    const events = await run({
      message: "Summarize this. " + "word ".repeat(80_000),
      model,
      session: session([], 20_000),
    });

    expect(contextStarts(events)).toHaveLength(1);
    expect(summaries).toBe(1);
    expect(events.map(({ type }) => type)).toContain("turn.settled");
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
  });

  it("fails the step when the strategy's result is still over the limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: session(
        [{ content: "Earlier notes. ".repeat(2_000), kind: "user", role: "user" }],
        2_000,
      ),
      strategy: { compact: async (history) => history },
    });

    expect(doStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      data: { outcome: "failed", error: { code: "COMPACTION_FAILED" } },
    });
  });

  it("fails when a strategy leaves a history the provider measured over the limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const history: HarnessSession["history"] = [
      { content: "Earlier notes.", kind: "user", role: "user" },
    ];
    const base = session(history, 10_000);
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: {
        ...base,
        compaction: {
          ...base.compaction,
          lastKnownInputTokens: 11_000,
          lastKnownPromptMessageCount: 1,
        },
      },
      strategy: { compact: async (messages) => messages },
    });

    expect(doStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      data: { outcome: "failed", error: { code: "COMPACTION_FAILED" } },
    });
  });

  it("leaves the session's messages as they were when a strategy edits them and throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = new ContextContainer();
    writeReactionsState(ctx, {
      ...readReactionsState(ctx),
      intents: [{ occurrence: "o", reactionId: "hooks/trim.ts", type: "compact" }],
    });
    const history: HarnessSession["history"] = [
      { content: "Original.", kind: "user", role: "user" },
    ];
    await run({
      ctx,
      message: "Thanks.",
      model: new MockLanguageModelV3({ doStream: async () => textStream("Done.", 500) }),
      session: session(history, 100_000),
      strategy: {
        compact: async (messages) => {
          (messages[0] as { content: string }).content = "Edited.";
          throw new Error("strategy broke");
        },
      },
    });

    expect(history[0]).toMatchObject({ content: "Original." });
  });

  it("ends a compaction as COMPACTION_FAILED, once, when the strategy returns an invalid history", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const compact = vi.fn<CompactionStrategy["compact"]>(async () => [
      { content: "No user message first.", role: "assistant" },
    ]);
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: session(
        [{ content: "Earlier notes. ".repeat(2_000), kind: "user", role: "user" }],
        2_000,
      ),
      strategy: { compact },
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(doStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      data: { outcome: "failed", error: { code: "COMPACTION_FAILED" } },
    });
  });

  it("fails an unchanged history even when the strategy rebuilds its messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const history: HarnessSession["history"] = [
      { content: "Earlier notes.", kind: "user", role: "user" },
    ];
    const base = session(history, 10_000);
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: {
        ...base,
        compaction: {
          ...base.compaction,
          lastKnownInputTokens: 11_000,
          lastKnownPromptMessageCount: 1,
        },
      },
      strategy: {
        compact: async (messages) =>
          messages.map((message) => Object.fromEntries(Object.entries(message).reverse())) as never,
      },
    });

    expect(doStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ data: { error: { code: "COMPACTION_FAILED" } } });
  });

  it("counts a result that dropped messages by its estimate, whatever the provider reported", async () => {
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const history: HarnessSession["history"] = Array.from({ length: 6 }, (_, index) => ({
      content: `Note ${index}.`,
      kind: "user" as const,
      role: "user" as const,
    }));
    const base = session(history, 10_000);
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: {
        ...base,
        compaction: {
          ...base.compaction,
          lastKnownInputTokens: 30_000,
          lastKnownPromptMessageCount: 6,
        },
      },
      strategy: { compact: async (messages) => messages.slice(-1) },
    });

    expect(doStream).toHaveBeenCalled();
    expect(events.at(-1)).not.toMatchObject({ data: { error: { code: "COMPACTION_FAILED" } } });
  });

  it("compacts when a strategy keeps every message and stubs the large one, under a large provider count", async () => {
    const doStream = vi.fn(async () => textStream("Done.", 500));
    const history: HarnessSession["history"] = [
      { content: "Earlier notes.", kind: "user", role: "user" },
      { content: "x".repeat(40_000), role: "assistant" },
      { content: "More notes.", kind: "user", role: "user" },
    ];
    const base = session(history, 10_000);
    const events = await run({
      message: "Please continue.",
      model: new MockLanguageModelV3({ doStream }),
      session: {
        ...base,
        compaction: {
          ...base.compaction,
          lastKnownInputTokens: 30_000,
          lastKnownPromptMessageCount: 3,
        },
      },
      strategy: {
        compact: async (messages) =>
          messages.map((message) =>
            typeof message.content === "string" && message.content.length > 1_000
              ? { ...message, content: "[moved to a file]" }
              : message,
          ) as never,
      },
    });

    expect(doStream).toHaveBeenCalled();
    expect(events.at(-1)).not.toMatchObject({ data: { error: { code: "COMPACTION_FAILED" } } });
  });

  it("gives a strategy a history with a URL file part, and compacts", async () => {
    const compact = vi.fn<CompactionStrategy["compact"]>(async (messages) => messages.slice(-1));
    const ctx = new ContextContainer();
    writeReactionsState(ctx, {
      ...readReactionsState(ctx),
      intents: [{ occurrence: "o", reactionId: "hooks/trim.ts", type: "compact" }],
    });
    const events = await run({
      ctx,
      message: "Thanks.",
      model: new MockLanguageModelV3({ doStream: async () => textStream("Done.", 500) }),
      session: session(
        [
          {
            content: [
              { type: "file", data: new URL("https://example.com/a.png"), mediaType: "image/png" },
            ],
            kind: "user",
            role: "user",
          },
        ],
        100_000,
      ),
      strategy: { compact },
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
  });

  it.each([
    ["throws", async (): Promise<never> => Promise.reject(new Error("strategy broke"))],
    [
      "drops a tool result",
      async (history: readonly HarnessModelMessage[]) =>
        history.filter(({ role }) => role !== "tool"),
    ],
  ])(
    "settles a requested compaction as failed when the strategy %s, and the turn goes on",
    async (_name, compact) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = new ContextContainer();
      writeReactionsState(ctx, {
        ...readReactionsState(ctx),
        intents: [{ occurrence: "o", reactionId: "hooks/trim.ts", type: "compact" }],
      });
      const history: HarnessSession["history"] = [
        { content: "Look it up.", kind: "user", role: "user" },
        {
          content: [{ input: {}, toolCallId: "c1", toolName: "lookup", type: "tool-call" }],
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "text", value: "Two cases." },
              toolCallId: "c1",
              toolName: "lookup",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ];
      const events = await run({
        ctx,
        message: "Thanks.",
        model: new MockLanguageModelV3({ doStream: async () => textStream("Done.", 500) }),
        session: session(history, 100_000),
        strategy: { compact },
      });

      expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
        { data: { outcome: "failed" } },
      ]);
      expect(events.map(({ type }) => type)).toContain("turn.settled");
      expect(events.some((event) => event.type === "session.ended")).toBe(false);
    },
  );

  it("compacts before the next model call when a hook asked, and only once", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => textStream("Done.", 500),
    });
    const compact = vi.fn<CompactionStrategy["compact"]>(async (history) => history.slice(-1));
    const ctx = new ContextContainer();
    writeReactionsState(ctx, {
      ...readReactionsState(ctx),
      intents: [{ occurrence: "o", reactionId: "hooks/trim.ts", type: "compact" }],
    });

    const history = [
      { content: "First question.", kind: "user" as const, role: "user" as const },
      { content: "First answer.", role: "assistant" as const },
    ];
    const events = await run({
      ctx,
      message: "Second question.",
      model,
      session: session(history, 100_000),
      strategy: { compact },
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[1]).toMatchObject({ forced: true });
    expect(contextStarts(events)).toMatchObject([{ data: { cause: { hook: "hooks/trim.ts" } } }]);
    expect(readReactionsState(ctx).intents ?? []).toEqual([]);
  });
});
