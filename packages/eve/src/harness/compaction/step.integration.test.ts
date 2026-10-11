import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, StaticModelReferenceKey } from "#context/keys.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { getTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { attachClientContext } from "#internal/client-context.js";
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

describe("memory recalled after a compaction", () => {
  const question = "Which sources back the second claim?";
  const brief: HarnessModelMessage = {
    content: `Read this brief. ${"lorem ipsum ".repeat(1_500)}`,
    kind: "user",
    role: "user",
  };
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
  const lookup = (preamble?: string): StreamResult =>
    streamOf([
      { type: "stream-start", warnings: [] },
      ...(preamble === undefined
        ? []
        : ([
            { id: "preamble", type: "text-start" },
            { delta: preamble, id: "preamble", type: "text-delta" },
            { id: "preamble", type: "text-end" },
          ] satisfies StreamPart[])),
      { input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" },
      finish("tool-calls"),
    ]);

  /**
   * Runs a turn's steps with the `notes` memory slot. Returns the user-role text of each step's
   * model request and of the resulting history, in order.
   */
  async function runWithNotes(options: {
    readonly compactOnly?: boolean;
    readonly history: HarnessSession["history"];
    readonly input: StepInput;
    readonly steps?: readonly (() => StreamResult)[];
  }) {
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
        return (options.steps?.[stepPrompts.length - 1] ?? answer)();
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
      // Small enough that the long brief compacts before the turn's first model call.
      compaction: { recentWindowSize: 1, threshold: 2_000 },
      continuationToken: "http:memory-compaction-session",
      history: options.history,
      sessionId: "memory-compaction-session",
    };
    const result = await contextStorage.run(ctx, async () => {
      let stepped = await createToolLoopHarness({
        compactOnly: options.compactOnly,
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
        tools: new Map([
          [
            "lookup",
            {
              description: "Looks up the sources.",
              execute: async () => "Two cases.",
              inputSchema: jsonSchema({ type: "object" }),
              name: "lookup",
            },
          ],
        ]),
      })(session, options.input);
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
      return stepped;
    });
    const history = result.session.history.flatMap((message) =>
      message.role === "user" && typeof message.content === "string" ? [message.content] : [],
    );
    return { history, stepPrompts };
  }

  it("places the recall before the turn's user message, as turn.started does", async () => {
    const { stepPrompts } = await runWithNotes({
      history: [brief, { content: "I read the brief.", role: "assistant" }],
      input: { message: question },
    });

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

  it("keeps the client's context between the recall and the question on every step", async () => {
    const { history, stepPrompts } = await runWithNotes({
      history: [brief, { content: "I read the brief.", role: "assistant" }],
      input: attachClientContext({ message: question }, ["Alice is viewing claim 2."]),
      steps: [lookup, answer],
    });

    const expected = [
      "Notes at turn start.",
      "Summary of our conversation so far:",
      "Notes after compaction.",
      "Alice is viewing claim 2.",
      question,
    ];
    expect(stepPrompts).toEqual([expected, expected]);
    expect(history).toEqual(expected.filter((text) => text !== "Alice is viewing claim 2."));
  });

  it("places the recall before the question compaction replays", async () => {
    const { stepPrompts } = await runWithNotes({
      history: [],
      input: { message: question },
      // A long first reply pushes the second step over the threshold and folds the question
      // into the summary, so compaction replays it.
      steps: [() => lookup(`Let me check. ${"lorem ipsum ".repeat(1_500)}`), answer],
    });

    expect(stepPrompts).toEqual([
      ["Notes at turn start.", question],
      [
        "Notes at turn start.",
        "Summary of our conversation so far:",
        "Notes after compaction.",
        question,
      ],
    ]);
  });

  it("appends the recall after a compaction between turns", async () => {
    const { history } = await runWithNotes({
      compactOnly: true,
      history: [
        brief,
        { content: "I read the brief.", role: "assistant" },
        { content: question, kind: "user", role: "user" },
        { content: "The second claim cites two cases.", role: "assistant" },
      ],
      input: {},
    });

    // The next turn's input follows the recall, as it follows a turn.started recall.
    expect(history.at(-1)).toBe("Notes after compaction.");
  });
});
