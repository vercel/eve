import type { ContextReader } from "#context/key.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { AgentLimitsDefinition } from "#shared/agent-definition.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

export interface EffectiveAgentRuntime {
  readonly limits?: AgentLimitsDefinition;
  readonly thresholdPercent?: number;
  readonly turnAgent: RuntimeTurnAgent;
}

export function resolveEffectiveAgentRuntime(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  context: ContextReader,
): EffectiveAgentRuntime {
  return resolveEffectiveAgentRuntimeFromConfig(bundle, context.get(DynamicSubagentAgentConfigKey));
}

export function resolveEffectiveAgentRuntimeFromConfig(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  config: DynamicSubagentAgentConfig | undefined,
): EffectiveAgentRuntime {
  if (config === undefined) {
    return {
      limits: bundle.resolvedAgent.config.limits,
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
      turnAgent: bundle.turnAgent,
    };
  }

  return {
    limits: config.limits,
    thresholdPercent: config.compaction?.thresholdPercent,
    turnAgent: {
      ...bundle.turnAgent,
      compactionModel: config.compaction?.model,
      dynamicModel: undefined,
      model: config.model,
      outputSchema: config.outputSchema,
      reasoning: config.reasoning,
    },
  };
}
