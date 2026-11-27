import { describe, expect, it } from "vitest";

import {
  assertCompactionStrategyCompatible,
  modelCompaction,
  tagCompactionStrategy,
} from "#shared/compaction-strategy.js";

const strategy = () => undefined;
const fallback = () => undefined;
const forOpenAI = () =>
  tagCompactionStrategy(strategy, {
    description: "an OpenAI model",
    matches: ({ modelId }) => modelId.startsWith("openai/"),
  });

describe("modelCompaction", () => {
  it("reads a bare strategy as a strategy with no fallback", () => {
    expect(modelCompaction(strategy, "experimental.compaction")).toEqual({ strategy });
  });

  it("keeps the fallback beside the strategy", () => {
    expect(modelCompaction({ fallback, strategy }, "experimental.compaction")).toEqual({
      fallback,
      strategy,
    });
  });

  it.each([
    ["a string", "x"],
    ["an object with no strategy", { fallback }],
    ["an object whose strategy is not a function", { strategy: "x" }],
  ])("rejects %s", (_name, value) => {
    expect(() => modelCompaction(value as never, "experimental.compaction")).toThrow(
      '"experimental.compaction" must be a compaction strategy, or { strategy, fallback } with a strategy function.',
    );
  });

  it("rejects a fallback that is not a function", () => {
    expect(() =>
      modelCompaction({ fallback: "x", strategy } as never, "experimental.compaction"),
    ).toThrow('"experimental.compaction.fallback" must be a compaction strategy: a function.');
  });
});

describe("assertCompactionStrategyCompatible", () => {
  const anthropic = { modelId: "anthropic/claude-opus-5", provider: "gateway" };
  const openai = { modelId: "openai/gpt-5.5", provider: "gateway" };

  it("accepts an untagged strategy, and no strategy, on any model", () => {
    expect(() => assertCompactionStrategyCompatible({ strategy }, anthropic)).not.toThrow();
    expect(() => assertCompactionStrategyCompatible(undefined, anthropic)).not.toThrow();
  });

  it("accepts a tagged strategy and fallback on a model they work with", () => {
    expect(() =>
      assertCompactionStrategyCompatible({ fallback: forOpenAI(), strategy: forOpenAI() }, openai),
    ).not.toThrow();
  });

  it("names the strategy when it works with another model", () => {
    expect(() => assertCompactionStrategyCompatible({ strategy: forOpenAI() }, anthropic)).toThrow(
      "The compaction strategy works with an OpenAI model, but the model is gateway (anthropic/claude-opus-5).",
    );
  });

  it("names the fallback when it works with another model", () => {
    expect(() =>
      assertCompactionStrategyCompatible({ fallback: forOpenAI(), strategy }, anthropic),
    ).toThrow("The compaction fallback works with an OpenAI model");
  });
});
