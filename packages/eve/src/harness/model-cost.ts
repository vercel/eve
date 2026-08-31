import type { LanguageModel, LanguageModelUsage, ProviderMetadata } from "ai";

import { classifyModelRouting } from "#internal/classify-model-routing.js";
import {
  createRuntimeModelCatalog,
  type RuntimeModelCatalog,
} from "#runtime/agent/model-catalog.js";
import type { InternalAgentModelDefinition } from "#shared/agent-definition.js";
import type { ModelCostEstimate, ModelCostSource } from "#shared/model-cost.js";

const modelCatalog = createRuntimeModelCatalog();

export interface ResolvedModelCost {
  readonly costUsd: number;
  readonly source: ModelCostSource;
}

/**
 * Resolves base pricing only for model calls that cannot rely on ordinary
 * Gateway cost metadata. The catalog is process-cached and lookup failures are
 * intentionally invisible to the model call.
 */
export async function resolveModelCostEstimate(input: {
  readonly catalog?: RuntimeModelCatalog;
  readonly model: LanguageModel;
  readonly modelReference: InternalAgentModelDefinition;
}): Promise<ModelCostEstimate | undefined> {
  try {
    const routing = classifyModelRouting(input.model, input.modelReference.providerOptions);
    if (routing.kind === "gateway" && routing.byok === undefined) return undefined;
    const catalog = input.catalog ?? modelCatalog;
    if (typeof input.model === "string" || input.model.provider.split(".")[0] === "gateway") {
      return (await catalog.getByGatewayId(input.modelReference.id))?.costEstimate;
    }
    return (await catalog.getByProviderModelId(input.model.provider, input.model.modelId))
      ?.costEstimate;
  } catch {
    return undefined;
  }
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
