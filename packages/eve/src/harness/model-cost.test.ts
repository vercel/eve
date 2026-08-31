import { describe, expect, it } from "vitest";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { vi } from "vitest";

import { resolveModelCallCost, resolveModelCostEstimate } from "#harness/model-cost.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";

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
  it("looks up external providers by their provider-native model id", async () => {
    const catalog = createCatalog();

    await expect(
      resolveModelCostEstimate({
        catalog,
        model: { provider: "anthropic.messages", modelId: "claude-test" } as LanguageModel,
        modelReference: { id: "anthropic/claude-test" },
      }),
    ).resolves.toEqual(pricing);
    expect(catalog.getByProviderModelId).toHaveBeenCalledWith("anthropic.messages", "claude-test");
  });

  it("looks up request-scoped BYOK by its gateway model id", async () => {
    const catalog = createCatalog();

    await expect(
      resolveModelCostEstimate({
        catalog,
        model: "anthropic/claude-test" as LanguageModel,
        modelReference: {
          id: "anthropic/claude-test",
          providerOptions: { gateway: { byok: { anthropic: [{ apiKey: "test" }] } } },
        },
      }),
    ).resolves.toEqual(pricing);
    expect(catalog.getByGatewayId).toHaveBeenCalledWith("anthropic/claude-test");
  });

  it("does not load prices for ordinary Gateway calls", async () => {
    const catalog = createCatalog();

    await expect(
      resolveModelCostEstimate({
        catalog,
        model: "anthropic/claude-test" as LanguageModel,
        modelReference: { id: "anthropic/claude-test" },
      }),
    ).resolves.toBeUndefined();
    expect(catalog.getByGatewayId).not.toHaveBeenCalled();
  });
});

function createCatalog(): RuntimeModelCatalog & {
  getByGatewayId: ReturnType<typeof vi.fn<RuntimeModelCatalog["getByGatewayId"]>>;
  getByProviderModelId: ReturnType<typeof vi.fn<RuntimeModelCatalog["getByProviderModelId"]>>;
} {
  return {
    getByGatewayId: vi.fn(async () => ({
      costEstimate: pricing,
      contextWindowTokens: 1,
      resolvedModelId: "anthropic/claude-test",
    })),
    getByProviderModelId: vi.fn(async () => ({
      costEstimate: pricing,
      contextWindowTokens: 1,
      resolvedModelId: "anthropic/claude-test",
    })),
  };
}
