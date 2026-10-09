import { Experimental_DecisionMockModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { decide } from "#public/ai/index.js";

const localDecisionModel = vi.hoisted(() => vi.fn());
vi.mock("#internal/model-auth/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/transport.js")>()),
  localGatewayDecisionModel: localDecisionModel,
}));

const questions = {
  category: {
    type: "choice",
    instructions: "Select the team that can help with the request.",
    criteria: { billing: "Invoices and payments", support: "Product questions" },
  },
  urgent: { type: "boolean", instructions: "Does the request require immediate attention?" },
  priority: { type: "score", instructions: "Rate urgency.", criteria: ["Low", "High"] },
} as const;
const state = { request: "Alice needs a copy of her invoice." };

function decisionModel() {
  const doDecide = vi.fn(async () => ({
    answers: {
      category: { type: "choice" as const, choice: "billing" },
      urgent: { type: "boolean" as const, probability: 0.1 },
      priority: { type: "score" as const, score: 0.1 },
    },
    usage: { inputTokens: 42, outputTokens: 3 },
    warnings: [],
    providerMetadata: { fixture: { requestId: "request-1" } },
  }));
  return { doDecide, model: new Experimental_DecisionMockModelV4({ doDecide }) };
}

beforeEach(() => {
  localDecisionModel.mockReset();
  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("decide", () => {
  it("defaults to Jev using the local Gateway connection without a session context", async () => {
    const decider = decisionModel();
    localDecisionModel.mockReturnValue(decider.model);

    const result = await decide({ state, questions });

    expect(localDecisionModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(result.answers.category.choice).toBe("billing");
    expectTypeOf(result.answers.category.choice).toEqualTypeOf<"billing" | "support">();
    expectTypeOf(result.answers.urgent.probability).toEqualTypeOf<number>();
    expectTypeOf(result.answers.priority.score).toEqualTypeOf<number>();
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 3, totalTokens: 45 });
    expect(result.providerMetadata).toEqual({ fixture: { requestId: "request-1" } });
  });

  it("resolves an explicit model ID through the local connection", async () => {
    localDecisionModel.mockReturnValue(decisionModel().model);
    await decide({ model: "typesafe-ai/custom", state, questions });
    expect(localDecisionModel).toHaveBeenCalledWith("typesafe-ai/custom");
  });

  it("preserves the configured default provider for defaults and aliases", async () => {
    const decider = decisionModel();
    const factory = vi.fn(() => decider.model);
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { decisionModel: factory });
    localDecisionModel.mockReturnValue(decisionModel().model);

    await decide({ state, questions });
    await decide({ model: "internal-decider", state, questions });

    expect(factory.mock.calls).toEqual([["typesafe-ai/jev"], ["internal-decider"]]);
    expect(localDecisionModel).not.toHaveBeenCalled();
  });

  it("passes explicit model instances and request options through unchanged", async () => {
    const decider = decisionModel();
    const abortSignal = new AbortController().signal;
    await decide({
      model: decider.model,
      state,
      questions,
      abortSignal,
      headers: { "x-request-id": "request-1" },
      providerOptions: { fixture: { mode: "fast" } },
      maxRetries: 0,
    });

    expect(localDecisionModel).not.toHaveBeenCalled();
    expect(decider.doDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: [{ type: "json", value: state }],
        questions,
        abortSignal,
        headers: expect.objectContaining({ "x-request-id": "request-1" }),
        providerOptions: { fixture: { mode: "fast" } },
      }),
    );
  });

  it("preserves input and answer validation", async () => {
    const decider = decisionModel();
    await expect(decide({ model: decider.model, state, questions: {} })).rejects.toThrow();
    expect(decider.doDecide).not.toHaveBeenCalled();

    const invalid = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({ answers: {}, warnings: [] }),
    });
    await expect(decide({ model: invalid, state, questions })).rejects.toThrow(
      "exactly one answer",
    );
  });

  it("propagates provider errors and aborts before provider I/O", async () => {
    const error = new Error("Decision unavailable.");
    const failed = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        throw error;
      },
    });
    await expect(decide({ model: failed, state, questions, maxRetries: 0 })).rejects.toBe(error);

    const decider = decisionModel();
    await expect(
      decide({
        model: decider.model,
        state,
        questions,
        abortSignal: AbortSignal.abort(error),
      }),
    ).rejects.toBe(error);
    expect(decider.doDecide).not.toHaveBeenCalled();
  });
});
