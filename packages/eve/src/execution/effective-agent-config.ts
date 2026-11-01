import type { ContextReader } from "#context/key.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  AgentLimitsDefinition,
  AgentReasoningDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";

/** What the agent sets for every model call, whichever model it runs. */
export interface AgentSettings {
  readonly compactionModel?: RuntimeModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly thresholdPercent?: number;
}

/** The settings of the agent the step runs: `agent.ts`'s, or a dynamic subagent config's. */
export function agentSettings(step: {
  readonly ctx: Pick<ContextReader, "get" | "require">;
}): AgentSettings {
  const config = step.ctx.get(DynamicSubagentAgentConfigKey);
  if (config !== undefined) {
    return {
      compactionModel: config.compaction?.model,
      reasoning: config.reasoning,
      thresholdPercent: config.compaction?.thresholdPercent,
    };
  }
  const bundle = step.ctx.require(BundleKey);
  return {
    compactionModel: bundle.turnAgent.compactionModel,
    reasoning: bundle.turnAgent.reasoning,
    thresholdPercent: bundle.resolvedAgent.config?.compaction?.thresholdPercent,
  };
}

/** The session's limits: a dynamic subagent config's, else `agent.ts`'s. */
export function agentLimits(
  bundle: Pick<CompiledBundle, "resolvedAgent">,
  ctx: Pick<ContextReader, "get">,
): Pick<AgentLimitsDefinition, "sessionTimeoutMs"> | undefined {
  const config = ctx.get(DynamicSubagentAgentConfigKey);
  return config === undefined ? bundle.resolvedAgent.config?.limits : config.limits;
}

/**
 * The session's `limits.sessionUsage`: the agent's own, else the root agent's.
 * A dynamic subagent config can't carry one, so its sessions run the root's.
 */
export function resolveSessionUsageLimit(
  bundle: Pick<CompiledBundle, "graph" | "resolvedAgent">,
): SessionUsageLimit | undefined {
  const limit =
    bundle.resolvedAgent.config?.limits?.sessionUsage ??
    bundle.graph.nodesByNodeId.get(ROOT_RUNTIME_AGENT_NODE_ID)?.agent.config?.limits?.sessionUsage;
  return limit === false ? () => false : limit;
}
