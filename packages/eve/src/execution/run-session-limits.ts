import type { AgentLimitsDefinition } from "#shared/agent-definition.js";

type TokenLimit =
  | AgentLimitsDefinition["maxInputTokensPerSession"]
  | AgentLimitsDefinition["maxOutputTokensPerSession"];

/**
 * Resolves an authored token cap against an inherited parent cap. `false`
 * only means "uncapped" before inheritance; an actual inherited cap still
 * bounds the child.
 */
export function resolveInheritedTokenLimit(input: {
  readonly configured: TokenLimit | undefined;
  readonly inherited: TokenLimit | undefined;
}): TokenLimit | undefined {
  if (input.inherited === undefined || input.inherited === false) {
    return input.configured;
  }
  if (input.configured === undefined || input.configured === false) {
    return input.inherited;
  }
  return Math.min(input.configured, input.inherited);
}
