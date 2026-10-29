import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { nativeNext, nativeProgram } from "./native.js";
import type { Next, Program, ProgramContext } from "./program.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];

afterEach(() => {
  vi.restoreAllMocks();
});

function reply(text: string): StreamResult {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { id: "reply", type: "text-start" },
    { delta: text, id: "reply", type: "text-delta" },
    { id: "reply", type: "text-end" },
    {
      finishReason: { raw: undefined, unified: "stop" },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 50, total: 50 },
        outputTokens: { reasoning: 0, text: 8, total: 8 },
      },
    },
  ];
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

/** The model delivers `value` for the turn's output schema. */
function deliver(value: unknown): StreamResult {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify(value),
      toolCallId: "reply-1",
      toolName: REPLY_TOOL_NAME,
      type: "tool-call",
    },
    {
      finishReason: { raw: undefined, unified: "tool-calls" },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 50, total: 50 },
        outputTokens: { reasoning: 0, text: 8, total: 8 },
      },
    },
  ];
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function lastUserText(prompt: Prompt): string {
  const message = prompt.findLast((entry) => entry.role === "user");
  if (message === undefined || typeof message.content === "string") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Runs one turn of Alice's question under `program`, answering each model call with `answers`. */
async function runTurn(
  program: Program,
  answers: readonly unknown[],
  options: {
    readonly outputSchema?: HarnessSession["outputSchema"];
    readonly history?: HarnessSession["history"];
    readonly threshold?: number;
    readonly compactOnly?: boolean;
  } = {},
) {
  const { outputSchema } = options;
  const prompts: string[] = [];
  const fullPrompts: Prompt[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(lastUserText(prompt));
      fullPrompts.push(prompt);
      const answer = answers[Math.min(prompts.length, answers.length) - 1];
      return outputSchema === undefined ? reply(String(answer)) : deliver(answer);
    },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "step-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: options.threshold ?? 100_000 },
    continuationToken: "http:program-session",
    history: options.history ?? [],
    outputSchema,
    sessionId: "program-session",
  };
  const events: SessionEvent[] = [];
  const checker = createStreamChecker();
  const at = "2026-10-28T00:00:00.000Z";
  const issues: unknown[] = [];
  let position = 0;
  let stepped: StepResult | undefined;
  await contextStorage.run(new ContextContainer(), async () => {
    const fold = foldingHandler();
    stepped = await createToolLoopHarness({
      ...(options.compactOnly === true && { compactOnly: true }),
      handleEvent: async (publication, messages) => {
        const facts = eventsOf(publication);
        events.push(...facts);
        issues.push(...checker.check({ at, facts }, position++));
        await fold(publication, messages);
      },
      program,
      resolveModel: async () => model,
      tools: new Map(),
    })(
      session,
      options.compactOnly === true ? {} : { message: "Which sources back the second claim?" },
    );
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return { events, fullPrompts, issues, prompts, result: stepped! };
}

/** eve's own loop, except that `review` can send a settling output back to the model. */
function reviewing(
  review: (output: unknown, continuations: number) => string | undefined,
): Program {
  return (ctx) => ({
    next: (): Next => {
      const next = nativeNext(ctx);
      if (!("settle" in next)) return next;
      const note = review(next.settle.output, ctx.turn!.continuations);
      return note === undefined ? next : { model: { note } };
    },
  });
}

describe("session programs", () => {
  it("continues the turn with a program's note, and the turn settles once with the later reply", async () => {
    const seen: unknown[] = [];
    const { events, issues, prompts, result } = await runTurn(
      reviewing((output, continuations) => {
        seen.push({ continuations, output });
        return typeof output === "string" && output.includes("[1]")
          ? undefined
          : "Cite a source for the claim, as [1].";
      }),
      ["Two court cases back it.", "Two court cases back it [1]."],
    );

    expect(prompts).toEqual([
      "Which sources back the second claim?",
      "Cite a source for the claim, as [1].",
    ]);
    expect(seen).toEqual([
      { continuations: 0, output: "Two court cases back it." },
      { continuations: 1, output: "Two court cases back it [1]." },
    ]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it [1]." });
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(result.session.history).toContainEqual(
      expect.objectContaining({
        content: "Cite a source for the claim, as [1].",
        kind: "execution.continuation",
      }),
    );
    expect(issues).toEqual([]);
  });

  it("reads a delivered structured value, and keeps the schema for the continued call", async () => {
    const outputSchema = {
      additionalProperties: false,
      properties: { sources: { items: { type: "string" }, type: "array" } },
      required: ["sources"],
      type: "object",
    } as const;
    const seen: unknown[] = [];

    const { result } = await runTurn(
      reviewing((output) => {
        seen.push(output);
        return (output as { sources: string[] }).sources.length > 0
          ? undefined
          : "List at least one source.";
      }),
      [{ sources: [] }, { sources: ["Smith v. Jones"] }],
      { outputSchema },
    );

    expect(seen).toEqual([{ sources: [] }, { sources: ["Smith v. Jones"] }]);
    expect(result.settledTurn).toEqual({ output: { sources: ["Smith v. Jones"] } });
    expect(result.session.outputSchema).toBeUndefined();
  });

  it("lets eve's own loop decide once the turn has three notes", async () => {
    const review = vi.fn(() => "Try once more.");

    const { events, result } = await runTurn(reviewing(review), [
      "First draft.",
      "Second draft.",
      "Third draft.",
      "Fourth draft.",
    ]);

    expect(review).toHaveBeenCalledTimes(4);
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(4);
    expect(result.settledTurn).toEqual({ output: "Fourth draft." });
  });

  it("fails the turn with a generic error when the program throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, issues, result } = await runTurn(
      () => ({
        next: () => {
          throw new Error("critic service at 10.0.0.7 is down");
        },
      }),
      ["Two court cases back it."],
    );

    expect(result.settledTurn).toEqual({ isError: true, output: "The agent's program failed." });
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.7");
    expect(issues).toEqual([]);
  });

  it("fails the turn when a program calls the model again with nothing new to read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, result } = await runTurn(
      () => ({ next: { model: {} } }),
      ["Two court cases back it."],
    );

    expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
    expect(result.settledTurn).toEqual({ isError: true, output: "The agent's program failed." });
  });
});

/** Six earlier exchanges, about 2,400 characters of Alice's questions. */
const older: HarnessSession["history"] = Array.from({ length: 6 }, (_, index) => [
  {
    content: `Earlier question ${index}: ${"y".repeat(400)}`,
    kind: "user" as const,
    role: "user" as const,
  },
  { content: `Earlier answer ${index}.`, role: "assistant" as const },
]).flat();

/** eve's own loop, with `history` in place of eve's compaction. */
function compacting(history: (ctx: ProgramContext) => ProgramContext["history"]): Program {
  return (ctx) => ({
    ...nativeProgram(ctx),
    ...(ctx.compaction !== undefined && { history: () => history(ctx) }),
  });
}

describe("a session program's history", () => {
  it("replaces eve's compaction where eve measures the prompt over the threshold", async () => {
    const seen: unknown[] = [];
    const { events, fullPrompts, issues, result } = await runTurn(
      compacting((ctx) => {
        seen.push({ reason: ctx.compaction?.reason, turn: ctx.turn?.id });
        // Drop every earlier exchange, keeping the question the model answers next.
        return ctx.history.slice(-1);
      }),
      ["Two court cases back it."],
      { history: older, threshold: 600 },
    );

    expect(seen).toEqual([{ reason: "automatic", turn: "turn_0" }]);
    expect(JSON.stringify(fullPrompts[0])).not.toContain("Earlier question");
    expect(lastUserText(fullPrompts[0]!)).toBe("Which sources back the second claim?");
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    // No summary run: the program's history needed none.
    expect(
      events.filter((event) => event.type === "model.requested" && "changeId" in event.data.owner),
    ).toEqual([]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
    expect(issues).toEqual([]);
  });

  it("is read for session.compact(), between turns", async () => {
    const seen: unknown[] = [];
    const { events, result } = await runTurn(
      compacting((ctx) => {
        seen.push({ reason: ctx.compaction?.reason, turn: ctx.turn });
        return ctx.history.slice(-2);
      }),
      [],
      { compactOnly: true, history: older },
    );

    expect(seen).toEqual([{ reason: "manual", turn: null }]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(result.session.history).toEqual(older.slice(-2));
  });

  it("fails the change when an automatic history drops the turn's input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, prompts } = await runTurn(
      compacting((ctx) => ctx.history.slice(0, 2)),
      ["Two court cases back it."],
      { history: older, threshold: 600 },
    );

    expect(prompts).toEqual([]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      {
        data: {
          error: { message: expect.stringContaining("drops the turn's input") },
          outcome: "failed",
        },
      },
    ]);
  });

  it("fails the change with a generic error when the program's history throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, prompts } = await runTurn(
      compacting(() => {
        throw new Error("summary service at 10.0.0.7 is down");
      }),
      ["Two court cases back it."],
      { history: older, threshold: 600 },
    );

    expect(prompts).toEqual([]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { error: { message: "The agent's program failed." }, outcome: "failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.7");
  });
});
