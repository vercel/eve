import type { LanguageModel, LanguageModelUsage, ProviderMetadata } from "ai";

import { AI_GATEWAY_MODELS_URL, vercelGatewayFetch } from "#internal/gateway.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import {
  gatewayModelListResponseSchema,
  modelCostEstimatesFromGatewayModelList,
} from "#internal/model-catalog.js";
import type { InternalAgentModelDefinition } from "#shared/agent-definition.js";
import type { ModelCostEstimate, ModelCostSource } from "#shared/model-cost.js";

let modelCostEstimatesPromise: Promise<Readonly<Record<string, ModelCostEstimate>>> | undefined;

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
  readonly model: LanguageModel;
  readonly modelReference: InternalAgentModelDefinition;
  readonly prices?: Readonly<Record<string, ModelCostEstimate>>;
}): Promise<ModelCostEstimate | undefined> {
  try {
    const routing = classifyModelRouting(input.model, input.modelReference.providerOptions);
    if (routing.kind === "gateway" && routing.byok === undefined) return undefined;
    const prices = input.prices ?? (await loadModelCostEstimates());
    return prices[input.modelReference.id];
  } catch {
    return undefined;
  }
}

function loadModelCostEstimates(): Promise<Readonly<Record<string, ModelCostEstimate>>> {
  if (modelCostEstimatesPromise === undefined) {
    modelCostEstimatesPromise = vercelGatewayFetch(AI_GATEWAY_MODELS_URL)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `AI Gateway model list request failed with HTTP ${response.status} ${response.statusText}.`,
          );
        }
        const parsed = gatewayModelListResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error("AI Gateway model list response did not match the expected schema.");
        }
        return modelCostEstimatesFromGatewayModelList(parsed.data.data);
      })
      .catch((error: unknown) => {
        modelCostEstimatesPromise = undefined;
        throw error;
      });
  }
  return modelCostEstimatesPromise;
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
