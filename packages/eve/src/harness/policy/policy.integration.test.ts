import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { createKernel } from "#harness/kernel.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { nativeNext } from "./native.js";
import type { Next, Policy } from "./policy.js";

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
  outputSchema?: HarnessSession["outputSchema"],
) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(lastUserText(prompt));
      const answer = answers[Math.min(prompts.length, answers.length) - 1];
      return outputSchema === undefined ? reply(String(answer)) : deliver(answer);
    },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "step-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:program-session",
    history: [],
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
    stepped = await createKernel({
      handleEvent: async (publication, messages) => {
        const facts = eventsOf(publication);
        events.push(...facts);
        issues.push(...checker.check({ at, facts }, position++));
        await fold(publication, messages);
      },
      policy,
      resolveModel: async () => model,
      tools: new Map(),
    })(session, { message: "Which sources back the second claim?" });
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return { events, issues, prompts, result: stepped! };
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
      outputSchema,
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
