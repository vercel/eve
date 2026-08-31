import { describe, expect, it } from "vitest";
import type { LanguageModel, LanguageModelUsage } from "ai";

import { resolveModelCallCost, resolveModelCostEstimate } from "#harness/model-cost.js";

const pricing = {
  inputUsdPerToken: 0.000003,
  outputUsdPerToken: 0.000015,
  cacheReadUsdPerToken: 0.0000003,
  cacheWriteUsdPerToken: 0.00000375,
};

function usage(input: Partial<LanguageModelUsage>): LanguageModelUsage {
  return {
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    inputTokens: undefined,
    outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
    outputTokens: undefined,
    totalTokens: undefined,
    ...input,
  };
}

describe("resolveModelCallCost", () => {
  it("prefers the cost reported by AI Gateway", () => {
    expect(
      resolveModelCallCost({
        costEstimate: pricing,
        providerMetadata: { gateway: { cost: "0.000082" } },
        usage: usage({ inputTokens: 100, outputTokens: 10 }),
      }),
    ).toEqual({ costUsd: 0.000082, source: "gateway" });
  });

  it("estimates uncached and cached tokens independently", () => {
    const cost = resolveModelCallCost({
      costEstimate: pricing,
      usage: usage({
        inputTokens: 100,
        outputTokens: 10,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 20, cacheWriteTokens: 30 },
      }),
    });

    expect(cost?.source).toBe("estimated");
    expect(cost?.costUsd).toBeCloseTo(0.0004185);
  });

  it("does not emit a partial estimate", () => {
    expect(
      resolveModelCallCost({
        costEstimate: pricing,
        usage: usage({ inputTokens: 100 }),
      }),
    ).toBeUndefined();
  });

  it("never charges negative uncached input tokens", () => {
    expect(
      resolveModelCallCost({
        costEstimate: pricing,
        usage: usage({
          inputTokens: 10,
          outputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: 20,
            cacheWriteTokens: 30,
          },
        }),
      }),
    ).toEqual({ costUsd: 0.0001335, source: "estimated" });
  });
});

describe("resolveModelCostEstimate", () => {
  it("uses the canonical model id for external providers", async () => {
    await expect(
      resolveModelCostEstimate({
        model: { provider: "anthropic.messages", modelId: "claude-test" } as LanguageModel,
        modelReference: { id: "anthropic/claude-test" },
        prices: { "anthropic/claude-test": pricing },
      }),
    ).resolves.toEqual(pricing);
  });

  it("uses the canonical model id for request-scoped BYOK", async () => {
    await expect(
      resolveModelCostEstimate({
        model: "anthropic/claude-test" as LanguageModel,
        modelReference: {
          id: "anthropic/claude-test",
          providerOptions: { gateway: { byok: { anthropic: [{ apiKey: "test" }] } } },
        },
        prices: { "anthropic/claude-test": pricing },
      }),
    ).resolves.toEqual(pricing);
  });

  it("does not load prices for ordinary Gateway calls", async () => {
    await expect(
      resolveModelCostEstimate({
        model: "anthropic/claude-test" as LanguageModel,
        modelReference: { id: "anthropic/claude-test" },
        prices: { "anthropic/claude-test": pricing },
      }),
    ).resolves.toBeUndefined();
  });
});
