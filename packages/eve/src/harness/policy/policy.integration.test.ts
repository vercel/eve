import { attachClientContext } from "#internal/client-context.js";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { createKernel } from "#harness/kernel.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { recordUsage } from "#harness/usage-sink.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { reactionSession } from "#internal/testing/reaction-session.js";
import { nativeNext, nativePolicy } from "./native.js";
import { harnessPolicy } from "./authored.js";
import type { SessionFrame } from "#dynamic/definition.js";
import type { Next, Policy, PolicyContext } from "./policy.js";

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

/** Runs one turn of Alice's question under `policy`, answering each model call with `answers`. */
async function runTurn(
  policy: Policy,
  answers: readonly unknown[],
  options: {
    readonly outputSchema?: HarnessSession["outputSchema"];
    readonly history?: HarnessSession["history"];
    readonly threshold?: number;
    readonly compactOnly?: boolean;
    readonly clientContext?: readonly string[];
    /** The session's context, with the bundle its dynamic values come from. */
    readonly ctx?: ContextContainer;
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
      if (answer instanceof Error) throw answer;
      return outputSchema === undefined ? reply(String(answer)) : deliver(answer);
    },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "step-model" }, tools: [] },
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
  await contextStorage.run(options.ctx ?? new ContextContainer(), async () => {
    const fold = foldingHandler();
    stepped = await createKernel({
      ...(options.compactOnly === true && { compactOnly: true }),
      handleEvent: async (publication, messages) => {
        const facts = eventsOf(publication);
        events.push(...facts);
        issues.push(...checker.check({ at, facts }, position++));
        await fold(publication, messages);
      },
      policy,
      resolveModel: async () => model,
      tools: new Map(),
    })(
      session,
      options.compactOnly === true
        ? {}
        : attachClientContext(
            { message: "Which sources back the second claim?" },
            options.clientContext,
          ),
    );
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return { events, fullPrompts, issues, prompts, result: stepped! };
}

/** eve's own loop, except that `review` can send a settling output back to the model. */
function reviewing(review: (output: unknown, continuations: number) => string | undefined): Policy {
  return (ctx) => ({
    next: (): Next => {
      const next = nativeNext(ctx);
      if (!("settle" in next)) return next;
      const note = review(next.settle.output, ctx.turn!.continuations);
      return note === undefined ? next : { model: { note } };
    },
  });
}

describe("harness policies", () => {
  it("continues the turn with a policy's note, and the turn settles once with the later reply", async () => {
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

  it("fails the turn with a generic error when the policy throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, issues, result } = await runTurn(
      () => ({
        next: () => {
          throw new Error("critic service at 10.0.0.7 is down");
        },
      }),
      ["Two court cases back it."],
    );

    expect(result.settledTurn).toEqual({ isError: true, output: "The agent's harness failed." });
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.7");
    expect(issues).toEqual([]);
  });

  it("fails the turn when a policy calls the model again with nothing new to read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, result } = await runTurn(
      () => ({ next: { model: {} } }),
      ["Two court cases back it."],
    );

    expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
    expect(result.settledTurn).toEqual({ isError: true, output: "The agent's harness failed." });
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

describe("usage a policy records", () => {
  it("counts toward the session's usage", async () => {
    const { events, result } = await runTurn(
      (ctx) => ({
        next: async () => {
          await recordUsage({ inputTokens: 120, outputTokens: 30 });
          return nativeNext(ctx);
        },
      }),
      ["Two court cases back it."],
    );

    expect(
      events.filter((event) => event.type === "usage.recorded" && event.data.kind === "auxiliary"),
    ).toMatchObject([
      // At the turn's start, and after the model's answer.
      { data: { usage: { inputTokens: 120, outputTokens: 30 } } },
      { data: { usage: { inputTokens: 120, outputTokens: 30 } } },
    ]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
  });
});

describe("a harness policy's drafts", () => {
  it("drafts the model's answers until the policy settles, and replies with what it settles", async () => {
    const { events, issues } = await runTurn(
      reviewing((output) =>
        typeof output === "string" && output.includes("[1]")
          ? undefined
          : "Cite a source for the claim, as [1].",
      ),
      ["Two court cases back it.", "Two court cases back it [1]."],
    );

    const texts = events.flatMap((event) =>
      event.type === "content.completed" && event.data.kind === "text"
        ? [{ phase: event.data.phase, value: event.data.value }]
        : [],
    );
    expect(texts).toEqual([
      { phase: "draft", value: "Two court cases back it." },
      { phase: "draft", value: "Two court cases back it [1]." },
      { phase: "reply", value: "Two court cases back it [1]." },
    ]);
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { reply: ["turn_0.reply"] } },
    ]);
    expect(issues).toEqual([]);
  });
});

describe("a harness policy at the turn's start", () => {
  const replyOf = (events: readonly SessionEvent[]) =>
    events.filter((event) => event.type === "content.completed");

  it("ends the turn without the model, with its output as the reply", async () => {
    const { events, issues, prompts, result } = await runTurn(
      (ctx) => ({
        next: () =>
          ctx.turn?.lastStep === undefined
            ? { settle: { output: "Released v1.2 for Alice." } }
            : nativeNext(ctx),
      }),
      ["The model shouldn't answer."],
    );

    expect(prompts).toEqual([]);
    expect(events.filter((event) => event.type === "model.requested")).toEqual([]);
    expect(replyOf(events)).toMatchObject([
      {
        data: { kind: "text", phase: "reply", turnId: "turn_0", value: "Released v1.2 for Alice." },
      },
    ]);
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "completed", reply: ["turn_0.reply"] } },
    ]);
    expect(result.settledTurn).toEqual({ output: "Released v1.2 for Alice." });
    expect(result.session.history.slice(-2)).toMatchObject([
      { content: "Which sources back the second claim?", role: "user" },
      { content: "Released v1.2 for Alice.", role: "assistant" },
    ]);
    expect(issues).toEqual([]);
  });

  it("shows the model a note after the turn's input", async () => {
    const { prompts, result } = await runTurn(
      (ctx) => ({
        next: () =>
          ctx.turn?.lastStep === undefined
            ? { model: { note: "Bob reviewed the sources yesterday." } }
            : nativeNext(ctx),
      }),
      ["Two court cases back it."],
    );

    expect(prompts).toEqual(["Bob reviewed the sources yesterday."]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
  });

  it("fails the turn with the policy's message", async () => {
    const { events, prompts, result } = await runTurn(
      () => ({ next: { fail: { message: "Releases are paused until Monday." } } }),
      [],
    );

    expect(prompts).toEqual([]);
    expect(result.settledTurn).toEqual({
      isError: true,
      output: "Releases are paused until Monday.",
    });
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { error: { message: "Releases are paused until Monday." }, outcome: "failed" } },
    ]);
  });

  it("settles with structured output its schema accepts, and fails on output it rejects", async () => {
    const outputSchema = {
      additionalProperties: false,
      properties: { total: { type: "number" } },
      required: ["total"],
      type: "object",
    };
    const settling =
      (output: unknown): Policy =>
      (ctx) => ({
        next: () =>
          ctx.turn?.lastStep === undefined
            ? { settle: { output: output as never } }
            : nativeNext(ctx),
      });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const accepted = await runTurn(settling({ total: 42 }), [], { outputSchema });
    const rejected = await runTurn(settling({ total: "42" }), [], { outputSchema });

    expect(accepted.result.settledTurn).toEqual({ output: { total: 42 } });
    expect(replyOf(accepted.events)).toMatchObject([
      { data: { kind: "result", value: { total: 42 } } },
    ]);
    expect(rejected.result.settledTurn).toEqual({
      isError: true,
      output: "The agent could not produce a result matching the requested schema.",
    });
  });

  it("replaces the model's reply when it settles with output of its own", async () => {
    const { events, result } = await runTurn(
      (ctx) => ({
        next: () =>
          ctx.turn?.lastStep === undefined
            ? { model: {} }
            : { settle: { output: `${ctx.turn.lastStep.text} (Checked by Bob.)` } },
      }),
      ["Two court cases back it."],
    );

    expect(result.settledTurn).toEqual({ output: "Two court cases back it. (Checked by Bob.)" });
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { reply: ["turn_0.reply"] } },
    ]);
  });

  it("keeps the model's answers in history, adding the policy's reply after them", async () => {
    const settling =
      (output: (text: string | null) => string): Policy =>
      (ctx) => ({
        next: () =>
          ctx.turn?.lastStep === undefined
            ? { model: {} }
            : { settle: { output: output(ctx.turn.lastStep.text) } },
      });
    const assistant = (history: HarnessSession["history"]) =>
      history
        .filter((message) => message.role === "assistant")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        );

    const revised = await runTurn(
      settling(() => "Two court cases back it [1]."),
      ["Two court cases back it."],
    );
    const accepted = await runTurn(
      settling((text) => text ?? ""),
      ["Two court cases back it."],
    );

    expect(assistant(revised.result.session.history)).toEqual([
      "Two court cases back it.",
      "Two court cases back it [1].",
    ]);
    expect(assistant(accepted.result.session.history)).toEqual(["Two court cases back it."]);
  });
});

/** eve's own loop, with `history` deciding what the model reads about the past. */
function withHistory(
  history: (ctx: PolicyContext) => PolicyContext["history"] | undefined,
): Policy {
  return (ctx) => ({ ...nativePolicy(ctx), history: () => history(ctx) });
}

describe("eve's own loop", () => {
  it("sends the client's context with the turn's first model call", async () => {
    const { fullPrompts } = await runTurn(nativePolicy, ["Two court cases back it."], {
      clientContext: ["Alice is reading the second draft."],
    });

    expect(JSON.stringify(fullPrompts[0])).toContain("Alice is reading the second draft.");
  });

  it("keeps the turn's input in history when the model call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = await runTurn(nativePolicy, [new Error("upstream unavailable")]);

    expect(result.settledTurn).toMatchObject({ isError: true });
    expect(result.session.history).toMatchObject([
      { content: "Which sources back the second claim?", kind: "user", role: "user" },
    ]);
  });
});

describe("a harness policy's history", () => {
  it("is asked before every model call, with the call's size", async () => {
    const seen: unknown[] = [];
    const { events, result } = await runTurn(
      withHistory((ctx) => {
        seen.push({ compact: ctx.compact, sized: (ctx.size?.tokens ?? 0) > 0 });
        return ctx.history;
      }),
      ["Two court cases back it.", "Two court cases back it [1]."],
      { history: older },
    );

    expect(seen).toEqual([{ compact: undefined, sized: true }]);
    expect(events.filter((event) => event.type === "context.started")).toEqual([]);
    expect(result.session.history.slice(0, older.length)).toEqual(older);
  });

  it("rewrites what the model has read, as a change, when it returns something else", async () => {
    const { events, fullPrompts, issues, result } = await runTurn(
      // Drop every earlier exchange past 600 tokens, keeping the question the model answers next.
      withHistory((ctx) => (ctx.size!.tokens > 600 ? ctx.history.slice(-1) : ctx.history)),
      ["Two court cases back it."],
      { history: older },
    );

    expect(JSON.stringify(fullPrompts[0])).not.toContain("Earlier question");
    expect(lastUserText(fullPrompts[0]!)).toBe("Which sources back the second claim?");
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    // No summary run: the policy's history needed none.
    expect(
      events.filter((event) => event.type === "model.requested" && "changeId" in event.data.owner),
    ).toEqual([]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
    expect(issues).toEqual([]);
  });

  it("is asked for session.compact(), between turns", async () => {
    const seen: unknown[] = [];
    const { events, result } = await runTurn(
      withHistory((ctx) => {
        seen.push({ compact: ctx.compact, turn: ctx.turn });
        return ctx.compact === true ? ctx.history.slice(-2) : ctx.history;
      }),
      [],
      { compactOnly: true, history: older },
    );

    // The second is eve checking that the policy keeps what it returned.
    expect(seen).toEqual([
      { compact: true, turn: null },
      { compact: undefined, turn: null },
    ]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { kind: "compaction", outcome: "completed" } },
    ]);
    expect(result.session.history).toEqual(older.slice(-2));
  });

  it("fails the change when a rewrite drops the turn's input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, prompts } = await runTurn(
      withHistory((ctx) => (ctx.size!.tokens > 600 ? ctx.history.slice(0, 2) : ctx.history)),
      ["Two court cases back it."],
      { history: older },
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

  it("fails the turn when it keeps rewriting what it returned", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let asked = 0;

    const { events, prompts } = await runTurn(
      // A different first answer each time it's asked.
      withHistory((ctx) => [
        { content: `Earlier answer, revision ${++asked}.`, role: "assistant" as const },
        ...ctx.history.slice(1),
      ]),
      ["Two court cases back it."],
      { history: older },
    );

    expect(prompts).toEqual([]);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      {
        data: {
          error: { message: expect.stringContaining("changes what it returned") },
          outcome: "failed",
        },
      },
    ]);
  });

  it("fails the turn with a generic error when the policy's history throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, prompts, result } = await runTurn(
      withHistory(() => {
        throw new Error("summary service at 10.0.0.7 is down");
      }),
      ["Two court cases back it."],
      { history: older },
    );

    expect(prompts).toEqual([]);
    expect(result.settledTurn).toMatchObject({ isError: true });
    expect(JSON.stringify(events)).not.toContain("10.0.0.7");
  });
});

describe("a harness's history", () => {
  // The kernel decides the same way for a harness; only its context differs.
  const frame = () => ({ session: { id: "program-session" } }) as SessionFrame;

  it("becomes the session's history", async () => {
    const { events, fullPrompts, result } = await runTurn(
      harnessPolicy(
        (ctx) => ({
          history: () => (ctx.size!.tokens > 600 ? ctx.history.slice(-1) : ctx.history),
        }),
        frame,
      ),
      ["Two court cases back it."],
      { history: older },
    );

    expect(JSON.stringify(fullPrompts[0])).not.toContain("Earlier question");
    expect(
      events.filter((event) => event.type === "model.requested" && "changeId" in event.data.owner),
    ).toEqual([]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
  });

  it("leaves the history to eve when it returns undefined", async () => {
    const { events } = await runTurn(
      harnessPolicy(() => ({ history: () => undefined }), frame),
      ["A summary of the earlier exchanges.", "Two court cases back it."],
      { history: older, threshold: 600 },
    );

    // eve's own compaction writes its summary with a model run the change owns.
    expect(
      events.filter((event) => event.type === "model.requested" && "changeId" in event.data.owner),
    ).toHaveLength(1);
  });

  it("summarizes with eve's summarizer, and keeps what it adds", async () => {
    const { events, result } = await runTurn(
      harnessPolicy(
        (ctx) => ({
          history: async () =>
            ctx.size!.tokens > 600 ? await ctx.summarize(ctx.history) : ctx.history,
        }),
        frame,
      ),
      ["A summary of the earlier exchanges.", "Two court cases back it."],
      { history: older, threshold: 600 },
    );

    expect(
      events.filter((event) => event.type === "model.requested" && "changeId" in event.data.owner),
    ).toHaveLength(1);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it." });
  });
});

/** An instructions value a policy declares itself, the way a file under `instructions/` would. */
describe("a harness policy's memos", () => {
  it("keep what one decision learned for its next evaluation in the turn", async () => {
    const { ctx } = reactionSession();
    let lookups = 0;
    const policy: Policy = (ctx) => ({
      ...nativePolicy(ctx),
      next: async (): Promise<Next> => {
        const next = nativeNext(ctx);
        // Alice's citation style, looked up once per turn.
        const style = await ctx.memo(["citation-style", ctx.turn!.id], () => {
          lookups += 1;
          return "[n]";
        });
        if (!("settle" in next) || ctx.turn!.continuations > 0) return next;
        return { model: { note: `Cite your sources as ${style}.` } };
      },
    });

    const { prompts, result } = await runTurn(
      policy,
      ["Two court cases back it.", "Two court cases back it [1]."],
      { ctx },
    );

    expect(prompts).toEqual(["Which sources back the second claim?", "Cite your sources as [n]."]);
    expect(result.settledTurn).toEqual({ output: "Two court cases back it [1]." });
    expect(lookups).toBe(1);
  });

  it("fail the turn generically where the step carries no session state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = await runTurn(
      (ctx) => ({ next: () => ctx.memo(["style"], () => ({ settle: { output: "Done." } })) }),
      ["Two court cases back it."],
    );

    expect(result.settledTurn).toEqual({ isError: true, output: "The agent's harness failed." });
  });
});
