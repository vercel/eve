import type { AgentReasoningDefinition } from "#shared/agent-definition.js";

import type { GatewayCatalogModel } from "./select-model.js";

/** A concrete reasoning effort level — every choice except the provider default. */
export type ReasoningLevel = Exclude<AgentReasoningDefinition, "provider-default">;

/**
 * What the AI Gateway catalog says a model supports, resolved before the
 * `/model` menu paints so unsupported controls never present as available.
 */
export interface GatewayModelCapabilities {
  /** Whether the model advertises adjustable reasoning (the `reasoning` catalog tag). */
  readonly reasoning: boolean;
  /** Effort levels worth offering for the model; empty when reasoning is unsupported. */
  readonly reasoningLevels: readonly ReasoningLevel[];
  /** Whether AI Gateway prices a `priority` service tier (Fast mode) for the model. */
  readonly fastMode: boolean;
}

/** Every effort level eve can author, offered when capabilities are unknown. */
export const ALL_REASONING_LEVELS: readonly ReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// The catalog carries no per-model level list, so levels are a best-effort
// read of what each provider's API accepts today; unknown reasoning-capable
// providers get the common core every provider maps.
const REASONING_LEVELS_BY_PROVIDER: Record<string, readonly ReasoningLevel[]> = {
  anthropic: ALL_REASONING_LEVELS,
  openai: ALL_REASONING_LEVELS,
  google: ["none", "low", "medium", "high"],
  xai: ["low", "high"],
};

const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = ["none", "low", "medium", "high"];

/**
 * Capabilities for `modelId` from a fetched catalog, or undefined when the
 * catalog is unavailable or does not list the model — the caller then treats
 * every control as potentially available.
 */
export function gatewayModelCapabilities(
  catalog: readonly GatewayCatalogModel[] | undefined,
  modelId: string | null,
): GatewayModelCapabilities | undefined {
  if (catalog === undefined || modelId === null) return undefined;
  const model = catalog.find((entry) => entry.id === modelId);
  if (model === undefined) return undefined;

  const reasoning = (model.tags ?? []).includes("reasoning");
  const provider = modelId.split("/")[0] ?? "";
  const tiers = model.pricing?.service_tiers;
  return {
    reasoning,
    reasoningLevels: reasoning
      ? (REASONING_LEVELS_BY_PROVIDER[provider] ?? DEFAULT_REASONING_LEVELS)
      : [],
    fastMode: tiers !== undefined && Object.hasOwn(tiers, "priority"),
  };
}
