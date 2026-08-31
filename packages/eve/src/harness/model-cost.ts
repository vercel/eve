import type { LanguageModelUsage, ProviderMetadata } from "ai";

import type { ModelCostEstimate, ModelCostSource } from "#shared/model-cost.js";

export interface ResolvedModelCost {
  readonly costUsd: number;
  readonly source: ModelCostSource;
}

/**
 * Uses the Gateway's billed amount when available. Direct and BYOK model calls
 * fall back to base per-token catalog prices, which are observability estimates.
 */
export function resolveModelCallCost(input: {
  readonly costEstimate?: ModelCostEstimate;
  readonly providerMetadata?: ProviderMetadata;
  readonly usage?: LanguageModelUsage;
}): ResolvedModelCost | undefined {
  const gatewayCost = readGatewayCostUsd(input.providerMetadata);
  if (gatewayCost !== undefined) return { costUsd: gatewayCost, source: "gateway" };

  const { costEstimate, usage } = input;
  if (
    costEstimate === undefined ||
    usage?.inputTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    return undefined;
  }

  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);
  const costUsd =
    uncachedInputTokens * costEstimate.inputUsdPerToken +
    cacheReadTokens * (costEstimate.cacheReadUsdPerToken ?? costEstimate.inputUsdPerToken) +
    cacheWriteTokens * (costEstimate.cacheWriteUsdPerToken ?? costEstimate.inputUsdPerToken) +
    usage.outputTokens * costEstimate.outputUsdPerToken;

  return Number.isFinite(costUsd) && costUsd >= 0 ? { costUsd, source: "estimated" } : undefined;
}

function readGatewayCostUsd(providerMetadata: ProviderMetadata | undefined): number | undefined {
  const gateway = providerMetadata?.gateway;
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) return undefined;
  const cost = gateway.cost;
  const parsed = typeof cost === "number" ? cost : typeof cost === "string" ? Number(cost) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
