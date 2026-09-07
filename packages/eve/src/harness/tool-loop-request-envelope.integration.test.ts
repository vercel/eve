import { getRequestEnvelopeTokens } from "#harness/request-envelope.js";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionDynamicInstructionsKey } from "#context/keys.js";
import { mockModel, type MockModelRequest } from "#evals/mock-model.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "task" },
      compactionModelReference: { id: "summary" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 0, threshold: 10_000 },
    continuationToken: "http:envelope",
    history: [],
    sessionId: "envelope",
  };
}

function setInstructions(ctx: ContextContainer, repetitions: number): string {
  const content = "tenant business policy ".repeat(repetitions);
  ctx.set(SessionDynamicInstructionsKey, { tenant: [{ role: "system", content }] });
  return content;
}

describe("model request envelope accounting", () => {
  it("preserves provider usage for stable instructions and compacts when they grow", async () => {
    const ctx = new ContextContainer();
    setInstructions(ctx, 600);
    const requests: MockModelRequest[] = [];
    let summaries = 0;
    const task = mockModel({
      respond(request) {
        requests.push(request);
        return { text: "Done.", usage: { inputTokens: 8_000 } };
      },
    });
    const summary = mockModel({
      respond: () => {
        summaries++;
        return "Earlier work is summarized.";
      },
    });
    const runStep = createToolLoopHarness({
      mode: "conversation",
      tools: new Map(),
      resolveModel: async (reference) =>
        (reference.id === "summary" ? summary : task) as LanguageModel,
    });
    const first = await contextStorage.run(ctx, () =>
      runStep(session(), { message: "First task." }),
    );
    const second = await contextStorage.run(ctx, () =>
      runStep(first.session, { message: "Second task." }),
    );
    expect(summaries).toBe(0);
    expect(second.session.compaction.lastKnownInputTokens).toBe(8_000);
    expect(getRequestEnvelopeTokens(second.session)).toBe(getRequestEnvelopeTokens(first.session));

    const policy = setInstructions(ctx, 1_400);
    const third = await contextStorage.run(ctx, () =>
      runStep(second.session, { message: "Third task." }),
    );
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.messages.some((message) => message.text.includes(policy))).toBe(true);
    expect(
      requests[2]!.messages.some((message) => message.text.includes("Earlier work is summarized.")),
    ).toBe(true);
    expect(third.session.history.some((message) => JSON.stringify(message).includes(policy))).toBe(
      false,
    );
  });

  it("rechecks instructions added before an empty-response retry", async () => {
    const ctx = new ContextContainer();
    const requests: MockModelRequest[] = [];
    let summaries = 0;
    const task = mockModel({
      respond(request) {
        requests.push(request);
        if (requests.length === 1) {
          setInstructions(ctx, 1_400);
          return "";
        }
        return "Recovered after compaction.";
      },
    });
    const summary = mockModel({
      respond: () => {
        summaries++;
        return "Checkpoint before retry.";
      },
    });
    const runStep = createToolLoopHarness({
      mode: "conversation",
      tools: new Map(),
      resolveModel: async (reference) =>
        (reference.id === "summary" ? summary : task) as LanguageModel,
    });
    const initial = session();
    const result = await contextStorage.run(ctx, () =>
      runStep(
        {
          ...initial,
          compaction: {
            ...initial.compaction,
            lastKnownInputTokens: 8_000,
            lastKnownPromptMessageCount: 1,
          },
          history: [{ role: "user", content: "Earlier task." }],
        },
        { message: "Continue." },
      ),
    );
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages.some((message) => message.text.includes("Checkpoint before retry.")),
    ).toBe(true);
    expect(result.session.history.at(-1)).toMatchObject({
      role: "assistant",
      content: expect.any(Array),
    });
  });
});
