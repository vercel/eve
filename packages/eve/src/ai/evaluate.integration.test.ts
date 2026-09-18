import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { evaluate } from "#public/ai/index.js";

const localEvaluationModel = vi.hoisted(() => vi.fn());
vi.mock("#internal/model-auth/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/transport.js")>()),
  localGatewayEvaluationModel: localEvaluationModel,
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

function evaluationModel() {
  const doEvaluate = vi.fn(async () => ({
    answers: {
      category: { type: "choice" as const, choice: "billing" },
      urgent: { type: "boolean" as const, probability: 0.1 },
      priority: { type: "score" as const, score: 0.1 },
    },
    usage: { inputTokens: 42, outputTokens: 3 },
    warnings: [],
    providerMetadata: { fixture: { requestId: "request-1" } },
  }));
  return { doEvaluate, model: new Experimental_EvaluationMockModelV4({ doEvaluate }) };
}

beforeEach(() => {
  localEvaluationModel.mockReset();
  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("evaluate", () => {
  it("defaults to Jev using the local Gateway connection without a session context", async () => {
    const evaluator = evaluationModel();
    localEvaluationModel.mockReturnValue(evaluator.model);

    const result = await evaluate({ state, questions });

    expect(localEvaluationModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(result.answers.category.choice).toBe("billing");
    expectTypeOf(result.answers.category.choice).toEqualTypeOf<"billing" | "support">();
    expectTypeOf(result.answers.urgent.probability).toEqualTypeOf<number>();
    expectTypeOf(result.answers.priority.score).toEqualTypeOf<number>();
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 3, totalTokens: 45 });
    expect(result.providerMetadata).toEqual({ fixture: { requestId: "request-1" } });
  });

  it("resolves an explicit model ID through the local connection", async () => {
    localEvaluationModel.mockReturnValue(evaluationModel().model);
    await evaluate({ model: "typesafe-ai/custom", state, questions });
    expect(localEvaluationModel).toHaveBeenCalledWith("typesafe-ai/custom");
  });

  it("preserves the configured default provider for defaults and aliases", async () => {
    const evaluator = evaluationModel();
    const factory = vi.fn(() => evaluator.model);
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { evaluationModel: factory });
    localEvaluationModel.mockReturnValue(evaluationModel().model);

    await evaluate({ state, questions });
    await evaluate({ model: "internal-evaluator", state, questions });

    expect(factory.mock.calls).toEqual([["typesafe-ai/jev"], ["internal-evaluator"]]);
    expect(localEvaluationModel).not.toHaveBeenCalled();
  });

  it("passes explicit model instances and request options through unchanged", async () => {
    const evaluator = evaluationModel();
    const abortSignal = new AbortController().signal;
    await evaluate({
      model: evaluator.model,
      state,
      questions,
      abortSignal,
      headers: { "x-request-id": "request-1" },
      providerOptions: { fixture: { mode: "fast" } },
      maxRetries: 0,
    });

    expect(localEvaluationModel).not.toHaveBeenCalled();
    expect(evaluator.doEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state,
        questions,
        abortSignal,
        headers: expect.objectContaining({ "x-request-id": "request-1" }),
        providerOptions: { fixture: { mode: "fast" } },
      }),
    );
  });

  it("preserves input and answer validation", async () => {
    const evaluator = evaluationModel();
    await expect(evaluate({ model: evaluator.model, state, questions: {} })).rejects.toThrow();
    expect(evaluator.doEvaluate).not.toHaveBeenCalled();

    const invalid = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({ answers: {}, warnings: [] }),
    });
    await expect(evaluate({ model: invalid, state, questions })).rejects.toThrow(
      "exactly one answer",
    );
  });

  it("propagates provider errors and aborts before provider I/O", async () => {
    const error = new Error("Evaluation unavailable.");
    const failed = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        throw error;
      },
    });
    await expect(evaluate({ model: failed, state, questions, maxRetries: 0 })).rejects.toBe(error);

    const evaluator = evaluationModel();
    await expect(
      evaluate({
        model: evaluator.model,
        state,
        questions,
        abortSignal: AbortSignal.abort(error),
      }),
    ).rejects.toBe(error);
    expect(evaluator.doEvaluate).not.toHaveBeenCalled();
  });
});
