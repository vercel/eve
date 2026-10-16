import type { Attributes } from "#compiled/@vercel/agent-runs/index.js";
import {
  context as otelContext,
  createContextKey,
  propagation,
  trace,
  type TextMapSetter,
} from "#compiled/@opentelemetry/api/index.js";

import { stripEveTraceBaggage } from "#protocol/baggage.js";

const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");
const traceContextSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function createGatewayTraceContextHeaders(): Record<string, string> | undefined {
  const activeContext = otelContext.active();
  if (
    activeContext.getValue(SUPPRESS_TRACING_KEY) === true ||
    trace.getSpan(activeContext) === undefined
  ) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  propagation.inject(activeContext, headers, traceContextSetter);
  stripEveTraceBaggage(headers);
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** Converts Gateway response metadata to cost data. */
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
