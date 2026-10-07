/** Converts Gateway response metadata to cost data. */
import type { Attributes } from "#tracing/lib/index.js";
export function gatewayCostAttributes(input: {
  cost?: number;
  gatewayCost?: number;
  inputCost?: number;
  outputCost?: number;
  generationId?: string;
}): Attributes {
  return {
    "gen_ai.usage.cost": input.cost,
    "gen_ai.usage.gateway_cost": input.gatewayCost,
    "gen_ai.usage.input_cost": input.inputCost,
    "gen_ai.usage.output_cost": input.outputCost,
    "gen_ai.generation.id": input.generationId,
  };
}
export function readGatewayCostData(
  providerMetadata: Readonly<Record<string, unknown>> | undefined,
) {
  if (providerMetadata === undefined) return undefined;
  const gateway = providerMetadata.gateway;
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) return undefined;
  const data = gateway as Record<string, unknown>;
  return {
    cost: readUsd(data.cost),
    gatewayCost: readUsd(data.gatewayCost),
    inputCost: readUsd(data.inputInferenceCost),
    outputCost: readUsd(data.outputInferenceCost),
    generationId:
      typeof data.generationId === "string" && data.generationId.length > 0
        ? data.generationId
        : undefined,
  };
}

function readUsd(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
