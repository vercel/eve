import type { AgentReasoningDefinition } from "./agent-definition.js";

/**
 * Model used when an agent does not declare one, baked in by `eve init`, and
 * pre-selected in the setup model picker.
 */
export const DEFAULT_AGENT_MODEL_ID = "openai/gpt-6-luna-fast";
export const DEFAULT_AGENT_REASONING = "high";

export function resolveInitAgentSettings(options: {
  model?: string;
  reasoning?: AgentReasoningDefinition;
}): { model: string; reasoning: AgentReasoningDefinition | undefined } {
  return {
    model: options.model ?? DEFAULT_AGENT_MODEL_ID,
    reasoning:
      options.reasoning ?? (options.model === undefined ? DEFAULT_AGENT_REASONING : undefined),
  };
}
