import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { anthropic } from "#public/models/anthropic/index.js";

import { auto } from "./auto.js";

const runtime = vi.hoisted(() => ({
  localEvaluationModel: vi.fn(),
  state: undefined as ContextContainer | undefined,
}));
vi.mock("#context/container.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#context/container.js")>()),
  loadContext: () => runtime.state!,
}));
vi.mock("#internal/model-auth/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/transport.js")>()),
  localGatewayEvaluationModel: runtime.localEvaluationModel,
}));

const options = {
  "openai/large": "Difficult investigations",
  "openai/small": "Routine requests",
} as const;

function context(
  text = "Alice requests a routine summary.",
  abortSignal = new AbortController().signal,
): DynamicResolveContext {
  return {
    model: null,
    channel: {},
    session: { context: {}, id: "test", auth: { current: null, initiator: null } },
    messages: [{ role: "user", content: text }],
    abortSignal,
  };
}

function event(turnId = "turn_1") {
  return { type: "step.started", data: { turnId } };
}

function evaluationModel(choice = "openai/small", modelId = "fixture-evaluator") {
  const doEvaluate = vi.fn(async () => ({
    answers: { route: { type: "choice" as const, choice } },
    usage: { inputTokens: 42, outputTokens: 3 },
    warnings: [],
    response: { modelId },
  }));
  return {
    doEvaluate,
    model: new Experimental_EvaluationMockModelV4({ modelId, doEvaluate }),
  };
}

beforeEach(() => {
  runtime.state = new ContextContainer();
  runtime.localEvaluationModel.mockReset();
});

describe("auto", () => {
  it("defaults to Jev through the AI SDK default provider", async () => {
    const evaluator = evaluationModel();
    const evaluationModelFactory = vi.fn(() => evaluator.model);
    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", { evaluationModel: evaluationModelFactory });
    try {
      const handler = auto({ options }).events["step.started"]!;
      await expect(handler(event(), context())).resolves.toBe("openai/small");
      expect(runtime.localEvaluationModel).not.toHaveBeenCalled();
      expect(evaluationModelFactory).toHaveBeenCalledWith("typesafe-ai/jev");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      else Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
    }
  });

  it("preserves a custom default provider when the local Gateway connection is available", async () => {
    const evaluator = evaluationModel();
    const localEvaluator = evaluationModel("openai/large");
    runtime.localEvaluationModel.mockReturnValue(localEvaluator.model);
    const evaluationModelFactory = vi.fn(() => evaluator.model);
    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", { evaluationModel: evaluationModelFactory });
    try {
      const handler = auto({ model: "internal-router", options }).events["step.started"]!;
      await expect(handler(event(), context())).resolves.toBe("openai/small");
      expect(evaluationModelFactory).toHaveBeenCalledWith("internal-router");
      expect(evaluator.doEvaluate).toHaveBeenCalledOnce();
      expect(runtime.localEvaluationModel).not.toHaveBeenCalled();
      expect(localEvaluator.doEvaluate).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      else Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
    }
  });

  it("uses the local Gateway connection for a string evaluation model", async () => {
    const evaluator = evaluationModel();
    runtime.localEvaluationModel.mockReturnValue(evaluator.model);

    const handler = auto({ options }).events["step.started"]!;

    await expect(handler(event(), context())).resolves.toBe("openai/small");
    expect(runtime.localEvaluationModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(evaluator.doEvaluate).toHaveBeenCalledOnce();
  });

  it("routes provider language models by alias and preserves reasoning", async () => {
    const languageModel = anthropic("sonnet-5");
    const evaluator = evaluationModel("private");
    const handler = auto({
      model: evaluator.model,
      options: {
        ...options,
        private: {
          model: languageModel,
          description: "Private provider requests",
          reasoning: "low",
        },
      },
    }).events["step.started"]!;

    await expect(handler(event(), context())).resolves.toEqual({
      model: languageModel,
      reasoning: "low",
    });
    expect(evaluator.doEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { messages: [{ role: "user", text: "Alice requests a routine summary." }] },
        questions: {
          route: expect.objectContaining({
            criteria: {
              ...options,
              private: "Private provider requests",
            },
          }),
        },
      }),
    );
  });

  it("evaluates once per turn and restores the selection from durable context", async () => {
    const evaluator = evaluationModel();
    const handler = auto({ model: evaluator.model, options }).events["step.started"]!;

    await handler(event(), context());
    runtime.state = await deserializeContext(serializeContext(runtime.state!));
    await handler(event(), context());
    await handler(event("turn_2"), context());

    expect(evaluator.doEvaluate).toHaveBeenCalledTimes(2);
    expect(Object.keys(serializeContext(runtime.state!))).toEqual([
      expect.stringMatching(/^eve\.experimental\.evaluate\.model\./),
    ]);
  });

  it("propagates provider errors and cancellation", async () => {
    const providerError = new Error("evaluation unavailable");
    const failed = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        throw providerError;
      },
    });
    const failedHandler = auto({ model: failed, options }).events["step.started"]!;
    await expect(failedHandler(event(), context())).rejects.toBe(providerError);

    runtime.state = new ContextContainer();
    const controller = new AbortController();
    const pendingModel = new Experimental_EvaluationMockModelV4({
      doEvaluate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    });
    const pendingHandler = auto({ model: pendingModel, options }).events["step.started"]!;
    const pending = pendingHandler(event(), context("Alice needs help.", controller.signal));
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects invalid configurations and input", async () => {
    const evaluator = evaluationModel().model;
    expect(() => auto({ model: evaluator, options: {} })).toThrow("at least one option");
    expect(() => auto({ model: evaluator, options: { broken: "" } })).toThrow();
    expect(() => auto({ model: "", options })).toThrow("valid evaluation model");
    expect(() =>
      auto({
        model: evaluator,
        options: {
          broken: { model: "openai/large", description: "Difficult", reasoning: "maximum" },
        },
      } as never),
    ).toThrow();

    const handler = auto({ model: evaluator, options }).events["step.started"]!;
    await expect(handler(event(), context(" "))).rejects.toThrow("requires user text");
  });
});
