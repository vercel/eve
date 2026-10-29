import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import type { AgentLoopDefinition } from "#shared/loop-stage.js";

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

function lastUserText(prompt: Prompt): string {
  const message = prompt.findLast((entry) => entry.role === "user");
  if (message === undefined || typeof message.content === "string") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Runs one turn of Alice's question with `loop`, answering each model call with `answers`. */
async function runTurn(loop: AgentLoopDefinition, answers: readonly string[]) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(lastUserText(prompt));
      return reply(answers[Math.min(prompts.length, answers.length) - 1] ?? "");
    },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "step-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:before-settle-session",
    history: [],
    sessionId: "before-settle-session",
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
      handleEvent: async (publication, messages) => {
        const facts = eventsOf(publication);
        events.push(...facts);
        issues.push(...checker.check({ at, facts }, position++));
        await fold(publication, messages);
      },
      loop,
      resolveModel: async () => model,
      tools: new Map(),
    })(session, { message: "Which sources back the second claim?" });
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return { events, issues, prompts, result: stepped! };
}

describe("experimental.loop.beforeSettle", () => {
  it("continues the turn with its note, and the turn settles once with the later reply", async () => {
    const seen: unknown[] = [];
    const { events, issues, prompts, result } = await runTurn(
      {
        beforeSettle: (turn) => {
          seen.push({ continuations: turn.continuations, output: turn.output });
          return typeof turn.output === "string" && turn.output.includes("[1]")
            ? undefined
            : { continue: { note: "Cite a source for the claim, as [1]." } };
        },
      },
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

  it("settles without asking once the turn reaches maxContinuations", async () => {
    const beforeSettle = vi.fn(() => ({ continue: { note: "Try once more." } }));

    const { events, result } = await runTurn({ beforeSettle, maxContinuations: 2 }, [
      "First draft.",
      "Second draft.",
      "Third draft.",
    ]);

    expect(beforeSettle).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(3);
    expect(result.settledTurn).toEqual({ output: "Third draft." });
  });

  it("fails the turn with a generic error when the stage throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { events, issues, result } = await runTurn(
      {
        beforeSettle: () => {
          throw new Error("critic service at 10.0.0.7 is down");
        },
      },
      ["Two court cases back it."],
    );

    expect(result.settledTurn).toEqual({
      isError: true,
      output: "The agent's beforeSettle stage failed.",
    });
    expect(events.filter((event) => event.type === "turn.settled")).toMatchObject([
      { data: { outcome: "failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.7");
    expect(issues).toEqual([]);
  });
});
