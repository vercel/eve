import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { usageAttributes } from "#tracing/core/attributes.js";

/** Applies eve's structural token usage attributes to an agent span. */
export function setAgentUsage(span: Span, usage: InstrumentationUsage): void {
  for (const [key, value] of Object.entries(usageAttributes(usage))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

/** Applies standard GenAI token usage while retaining eve's compatibility attributes. */
export function setGenAiUsage(span: Span, usage: InstrumentationUsage): void {
  for (const [key, value] of Object.entries(usageAttributes(usage, true))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

export function setAgentInvocationUsage(
  span: Span,
  modelUsage: AgentTurnTraceState["modelUsage"],
): void {
  if (modelUsage === undefined) return;
  setGenAiUsage(span, modelUsage);
}

/** Projects Vercel AI Gateway cost metadata onto GenAI span attributes. */
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
