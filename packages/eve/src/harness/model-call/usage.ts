import type { LanguageModel, ProviderMetadata } from "ai";

import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  type TokenUsageDelta,
} from "#harness/turn-tag-state.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type { Step } from "#harness/step/context.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
/**
 * The model's gateway id, or `undefined` for a model without a string `provider`, such as a
 * test double, so a missing field never throws into the tool loop.
 */
export function gatewayModelId(model: LanguageModel): string | undefined {
  try {
    return formatLanguageModelGatewayId(model);
  } catch {
    return undefined;
  }
}

export function extractTokenUsageDelta(input: {
  readonly costUsd: number | undefined;
  readonly usage: HarnessStepResult["usage"] | undefined;
}): TokenUsageDelta | undefined {
  const usage = input.usage;
  if (usage === undefined && input.costUsd === undefined) {
    return undefined;
  }

  return {
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    costUsd: input.costUsd,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };
}

export function extractGatewayCostUsd(
  providerMetadata: ProviderMetadata | undefined,
): number | undefined {
  const gateway = readGatewayMetadata(providerMetadata);
  const cost = gateway?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = Number(cost);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readGatewayMetadata(
  providerMetadata: ProviderMetadata | undefined,
): ProviderMetadata[string] | undefined {
  const gateway = providerMetadata?.gateway;
  return gateway && typeof gateway === "object" && !Array.isArray(gateway) ? gateway : undefined;
}

/**
 * Tags the turn's workflow run with the model and the turn's running token totals. Each model
 * step is its own workflow step and attributes are last-write-wins, so the running total, kept in
 * session state, is what reaches the dashboard. Best-effort: tagging never breaks the loop.
 */
export async function recordModelUsage(
  step: Step,
  input: { readonly model: LanguageModel; readonly result: HarnessStepResult },
): Promise<void> {
  const usage = accumulateTurnUsage({
    previous: getTurnUsageState(step.session.state),
    turnId: step.position().turnId,
    usage: extractTokenUsageDelta({
      costUsd: extractGatewayCostUsd(input.result.providerMetadata),
      usage: input.result.usage,
    }),
  });
  step.session = setTurnUsageState(step.session, usage);
  await setEveAttributes({
    "$eve.model": gatewayModelId(input.model),
    "$eve.input_tokens": usage.inputTokens,
    "$eve.output_tokens": usage.outputTokens,
    "$eve.cache_read_tokens": usage.cacheReadTokens,
    "$eve.cache_write_tokens": usage.cacheWriteTokens,
    "$eve.cost_usd": usage.sawCost ? usage.costUsd : undefined,
    "$eve.tool_count": step.config.tools.size,
  });
}
