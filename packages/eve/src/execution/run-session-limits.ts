import type { AgentLimitsDefinition } from "#shared/agent-definition.js";

type UsageLimit =
  | AgentLimitsDefinition["maxInputTokensPerSession"]
  | AgentLimitsDefinition["maxOutputTokensPerSession"]
  | AgentLimitsDefinition["maxTokenCostUsdPerSession"];

/**
 * Resolves an authored usage cap against an inherited parent cap. `false`
 * only means "uncapped" before inheritance; an actual inherited cap still
 * bounds the child.
 */
export function resolveInheritedTokenLimit(input: {
  readonly configured: UsageLimit | undefined;
  readonly inherited: UsageLimit | undefined;
}): UsageLimit | undefined {
  if (input.inherited === undefined || input.inherited === false) {
    return input.configured;
  }
  if (input.configured === undefined || input.configured === false) {
    return input.inherited;
  }
  return Math.min(input.configured, input.inherited);
}
