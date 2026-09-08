import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";

/** Applies eve's structural token usage attributes to an agent span. */
export function setAgentUsage(
  span: Span,
  usage: InstrumentationUsage,
  options: { readonly includeGenAiDetails?: boolean } = {},
): void {
  if (usage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", usage.outputTokens);
  }
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    if (options.includeGenAiDetails === false) {
      span.setAttribute("agent.usage.cache_read_tokens", details.cacheReadTokens);
    } else {
      span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cacheReadTokens);
    }
  }
  if (details?.cacheWriteTokens !== undefined) {
    if (options.includeGenAiDetails === false) {
      span.setAttribute("agent.usage.cache_write_tokens", details.cacheWriteTokens);
    } else {
      span.setAttribute("gen_ai.usage.cache_creation.input_tokens", details.cacheWriteTokens);
    }
  }
}

export function setAgentInvocationUsage(
  span: Span,
  modelUsage: AgentTurnTraceState["modelUsage"],
): void {
  if (modelUsage === undefined) return;
  if (modelUsage.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", modelUsage.inputTokens);
  }
  if (modelUsage.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", modelUsage.outputTokens);
  }
}

/**
 * Extracts cost data from a step result's provider metadata. Only Vercel AI
 * Gateway reports it (`providerMetadata.gateway`): raw inference cost, the
 * gateway's surcharged total, the input/output split, and the generation id
 * for dashboard reconciliation. Values arrive as USD strings; anything
 * missing or non-numeric is skipped, so non-gateway providers get nothing.
 */
export function readGatewayCost(
  providerMetadata: Readonly<Record<string, unknown>>,
): Record<string, string | number> | undefined {
  const gateway = providerMetadata.gateway;
  if (!isRecord(gateway)) return undefined;
  const attributes: Record<string, string | number> = {};
  const cost = readUsd(gateway.cost);
  if (cost !== undefined) attributes["gen_ai.usage.cost"] = cost;
  const gatewayCost = readUsd(gateway.gatewayCost);
  if (gatewayCost !== undefined) attributes["gen_ai.usage.gateway_cost"] = gatewayCost;
  const inputCost = readUsd(gateway.inputInferenceCost);
  if (inputCost !== undefined) attributes["gen_ai.usage.input_cost"] = inputCost;
  const outputCost = readUsd(gateway.outputInferenceCost);
  if (outputCost !== undefined) attributes["gen_ai.usage.output_cost"] = outputCost;
  if (typeof gateway.generationId === "string" && gateway.generationId.length > 0) {
    attributes["gen_ai.generation.id"] = gateway.generationId;
  }
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

function readUsd(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
