import type { AgentReasoningDefinition } from "#shared/agent-definition.js";

import type { GatewayCatalogModel } from "./select-model.js";

export type ReasoningLevel = Exclude<AgentReasoningDefinition, "provider-default">;

export interface GatewayModelCapabilities {
  readonly reasoning: boolean;
  readonly reasoningLevels: readonly ReasoningLevel[];
  readonly fastMode: boolean;
}

export const ALL_REASONING_LEVELS: readonly ReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function reasoningLevels(model: GatewayCatalogModel): readonly ReasoningLevel[] {
  return model.reasoningEfforts.filter((value): value is ReasoningLevel =>
    ALL_REASONING_LEVELS.includes(value as ReasoningLevel),
  );
}

export function gatewayModelCapabilities(
  catalog: readonly GatewayCatalogModel[] | undefined,
  modelId: string | null,
): GatewayModelCapabilities | undefined {
  if (catalog === undefined || modelId === null) return undefined;
  const model = catalog.find((entry) => entry.id === modelId);
  if (model === undefined) return undefined;

  const levels = reasoningLevels(model);
  const reasoning = (model.tags ?? []).includes("reasoning") || levels.length > 0;
  const tiers = model.pricing?.service_tiers;
  return {
    reasoning,
    reasoningLevels: levels,
    fastMode: tiers !== undefined && Object.hasOwn(tiers, "priority"),
  };
}
