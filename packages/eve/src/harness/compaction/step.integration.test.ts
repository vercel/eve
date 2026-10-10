import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, StaticModelReferenceKey } from "#context/keys.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { getTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import { defineMemory } from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { projectMemoryHistoryFromSessionState } from "#shared/memory-state.js";

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

describe("memory recalled after a compaction during a turn", () => {
  it("places the recall before the turn's user message, as turn.started does", async () => {
    const question = "Which sources back the second claim?";
    const notes: ResolvedMemoryDefinition = {
      ...defineMemory({
        description: "Notes about Alice's research.",
        provider: {
          recall: {
            "turn.started": async () => ({ messages: [{ content: "Notes at turn start." }] }),
            "compaction.completed": async () => ({
              messages: [{ content: "Notes after compaction." }],
            }),
          },
        },
        scope: "alice",
      }),
      logicalPath: "memory/notes.ts",
      slot: "notes",
      sourceId: "memory/notes.ts",
      sourceKind: "module",
      visibility: "scope",
    };
    const stepPrompts: string[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const system = prompt[0]?.role === "system" ? prompt[0].content : "";
        if (!system.includes("You help Alice.")) return summaryStream();
        stepPrompts.push(
          prompt.flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          ),
        );
        return streamOf([
          { type: "stream-start", warnings: [] },
          { id: "reply", type: "text-start" },
          { delta: "The second claim cites two cases.", id: "reply", type: "text-delta" },
          { id: "reply", type: "text-end" },
          {
            finishReason: { raw: undefined, unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 50, total: 50 },
              outputTokens: { reasoning: 0, text: 8, total: 8 },
            },
          },
        ]);
      },
    });
    const ctx = new ContextContainer();
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    ctx.set(StaticModelReferenceKey, { id: "step-model" });
    ctx.set(SessionKey, {
      auth: { current: auth, initiator: auth },
      sessionId: "memory-compaction-session",
      turn: { id: "turn_0", sequence: 0 },
    });
    const session: HarnessSession = {
      agent: { modelReference: { id: "step-model" }, system: "You help Alice.", tools: [] },
      // Small enough that the long history compacts before the turn's first model call.
      compaction: { recentWindowSize: 1, threshold: 2_000 },
      continuationToken: "http:memory-compaction-session",
      history: [
        { content: `Read this brief. ${"lorem ipsum ".repeat(1_500)}`, kind: "user", role: "user" },
        { content: "I read the brief.", role: "assistant" },
      ],
      sessionId: "memory-compaction-session",
    };

    await contextStorage.run(ctx, () =>
      createToolLoopHarness({
        handleEvent: foldingHandler(async (event, messages) => {
          await dispatchMemoryLifecycleEvent({
            appRoot: "",
            ctx,
            event,
            memories: [notes],
            messages,
            nodeId: "__root__",
          });
        }),
        historyProjector: projectMemoryHistoryFromSessionState,
        resolveModel: async () => model,
        tools: new Map(),
      })(session, { message: question }),
    );

    // The user-role text the model reads: the turn's question stays the latest user message.
    expect(stepPrompts).toEqual([
      [
        "Notes at turn start.",
        "Summary of our conversation so far:",
        "Notes after compaction.",
        question,
      ],
    ]);
  });
});
