import { Experimental_DecisionMockModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { anthropic } from "#public/models/anthropic/index.js";

import { auto } from "./auto.js";

const runtime = vi.hoisted(() => ({
  localDecisionModel: vi.fn(),
  logWarn: vi.fn(),
  state: undefined as ContextContainer | undefined,
}));
vi.mock("#context/container.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#context/container.js")>()),
  loadContext: () => runtime.state!,
}));
vi.mock("#internal/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/logging.js")>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: runtime.logWarn,
  }),
}));
vi.mock("#internal/model-auth/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/transport.js")>()),
  localGatewayDecisionModel: runtime.localDecisionModel,
}));

const options = {
  "openai/large": "Difficult investigations",
  "openai/small": "Routine requests",
} as const;

function context(
  text = "Alice requests a routine summary.",
  abortSignal = new AbortController().signal,
) {
  return { abortSignal, text };
}

/** Runs the reaction as the runner does: `select` over the conversation, then `resolve`. */
function run(definition: ReturnType<typeof auto>, input: ReturnType<typeof context>) {
  const selected = definition.select!(
    { messages: [{ role: "user", content: input.text }] } as never,
    {} as never,
  );
  return definition.resolve(selected, {
    abortSignal: input.abortSignal,
    channel: {},
    session: { id: "test", auth: { current: null, initiator: null } },
  });
}

function decisionModel(choice = "openai/small", modelId = "fixture-decider") {
  const doDecide = vi.fn(async () => ({
    answers: { route: { type: "choice" as const, choice } },
    usage: { inputTokens: 42, outputTokens: 3 },
    warnings: [],
    response: { modelId },
  }));
  return {
    doDecide,
    model: new Experimental_DecisionMockModelV4({ modelId, doDecide }),
  };
}

beforeEach(() => {
  runtime.state = new ContextContainer();
  runtime.localDecisionModel.mockReset();
  runtime.logWarn.mockReset();
});

describe("auto", () => {
  it("defaults to Jev through the AI SDK default provider", async () => {
    const decider = decisionModel();
    const decisionModelFactory = vi.fn(() => decider.model);
    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", { decisionModel: decisionModelFactory });
    try {
      const handler = auto({ options });
      await expect(run(handler, context())).resolves.toBe("openai/small");
      expect(runtime.localDecisionModel).not.toHaveBeenCalled();
      expect(decisionModelFactory).toHaveBeenCalledWith("typesafe-ai/jev");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      else Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
    }
  });

  it("preserves a custom default provider when the local Gateway connection is available", async () => {
    const decider = decisionModel();
    const localDecider = decisionModel("openai/large");
    runtime.localDecisionModel.mockReturnValue(localDecider.model);
    const decisionModelFactory = vi.fn(() => decider.model);
    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", { decisionModel: decisionModelFactory });
    try {
      const handler = auto({ model: "internal-router", options });
      await expect(run(handler, context())).resolves.toBe("openai/small");
      expect(decisionModelFactory).toHaveBeenCalledWith("internal-router");
      expect(decider.doDecide).toHaveBeenCalledOnce();
      expect(runtime.localDecisionModel).not.toHaveBeenCalled();
      expect(localDecider.doDecide).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      else Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
    }
  });

  it("uses the local Gateway connection for a string decision model", async () => {
    const decider = decisionModel();
    runtime.localDecisionModel.mockReturnValue(decider.model);

    const handler = auto({ options });

    await expect(run(handler, context())).resolves.toBe("openai/small");
    expect(runtime.localDecisionModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(decider.doDecide).toHaveBeenCalledOnce();
  });

  it("routes provider language models by alias and preserves reasoning", async () => {
    const languageModel = anthropic("sonnet-5");
    const decider = decisionModel("private");
    const handler = auto({
      model: decider.model,
      options: {
        ...options,
        private: {
          model: languageModel,
          description: "Private provider requests",
          reasoning: "low",
        },
      },
    });

    await expect(run(handler, context())).resolves.toEqual({
      model: languageModel,
      reasoning: "low",
    });
    expect(decider.doDecide).toHaveBeenCalledWith(
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

  it("uses and retains the fallback model when decision fails", async () => {
    const providerError = new Error("decision unavailable");
    const doDecide = vi.fn(async () => {
      throw providerError;
    });
    const failed = new Experimental_DecisionMockModelV4({ doDecide });
    const handler = auto({
      model: failed,
      fallback: "anthropic/claude-sonnet-5",
      options,
    });

    await expect(run(handler, context())).resolves.toBe("anthropic/claude-sonnet-5");
    expect(doDecide).toHaveBeenCalledOnce();
    expect(runtime.logWarn).toHaveBeenCalledOnce();
    expect(runtime.logWarn).toHaveBeenCalledWith("model decision failed; using fallback", {
      error: expect.objectContaining({
        message: expect.stringContaining("decision unavailable"),
      }),
      fallback: "anthropic/claude-sonnet-5",
    });
  });

  it("supports a provider model and reasoning as the fallback", async () => {
    const fallback = anthropic("sonnet-5");
    const failed = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        throw new Error("decision unavailable");
      },
    });
    const handler = auto({
      model: failed,
      fallback: { model: fallback, reasoning: "low" },
      options,
    });

    await expect(run(handler, context())).resolves.toEqual({
      model: fallback,
      reasoning: "low",
    });
    expect(runtime.logWarn).toHaveBeenCalledWith(
      "model decision failed; using fallback",
      expect.objectContaining({ fallback: "anthropic.messages/sonnet-5" }),
    );
  });

  it("propagates provider errors without a fallback and always propagates cancellation", async () => {
    const providerError = new Error("decision unavailable");
    const failed = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        throw providerError;
      },
    });
    const failedHandler = auto({ model: failed, options });
    await expect(run(failedHandler, context())).rejects.toBe(providerError);

    runtime.state = new ContextContainer();
    const controller = new AbortController();
    const pendingModel = new Experimental_DecisionMockModelV4({
      doDecide: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    });
    const pendingHandler = auto({
      model: pendingModel,
      fallback: "anthropic/claude-sonnet-5",
      options,
    });
    const pending = run(pendingHandler, context("Alice needs help.", controller.signal));
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects invalid configurations and input", async () => {
    const decider = decisionModel().model;
    expect(() => auto({ model: decider, options: {} })).toThrow("at least one option");
    expect(() => auto({ model: decider, options: { broken: "" } })).toThrow();
    expect(() => auto({ model: "", options })).toThrow("valid decision model");
    expect(() => auto({ model: decider, fallback: "", options })).toThrow("fallback model");
    expect(() => auto({ model: decider, fallback: {} as never, options })).toThrow(
      "fallback model",
    );
    expect(() =>
      auto({
        model: decider,
        options: {
          broken: { model: "openai/large", description: "Difficult", reasoning: "maximum" },
        },
      } as never),
    ).toThrow();

    const handler = auto({ model: decider, options });
    await expect(run(handler, context(" "))).rejects.toThrow("requires user text");
  });
});
