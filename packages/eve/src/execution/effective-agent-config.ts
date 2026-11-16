import type { ContextReader } from "#context/key.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { ApprovalPolicy } from "#approval/definition.js";
import { strictestApproval } from "#approval/agent.js";
import { sessionAgent } from "#definitions/agent.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";
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

/** The settings of the agent the step runs: its own, or a dynamic subagent config's. */
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
  const { settings } = sessionAgent(step.ctx);
  return {
    compactionModel: settings.compaction?.model,
    reasoning: settings.reasoning,
    thresholdPercent: settings.compaction?.thresholdPercent,
  };
}

/** The session's limits: a dynamic subagent config's, else the agent's own. */
export function agentLimits(
  agent: Pick<SessionAgent, "settings">,
  ctx: Pick<ContextReader, "get">,
): Pick<AgentLimitsDefinition, "sessionTimeoutMs"> | undefined {
  const config = ctx.get(DynamicSubagentAgentConfigKey);
  return config === undefined ? agent.settings.limits : config.limits;
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

/**
 * The session's agent-wide `approval`. The root agent's always applies, including in subagent
 * sessions; a subagent's own can only add to it, so no subagent (an extension's included) can
 * loosen the root's gates.
 */
export function resolveAgentApproval(
  bundle: Pick<CompiledBundle, "graph" | "nodeId" | "resolvedAgent">,
): ApprovalPolicy | undefined {
  const root = bundle.graph.nodesByNodeId.get(ROOT_RUNTIME_AGENT_NODE_ID)?.agent.config?.approval;
  // The root session's own policy is the root's, so it must not run twice.
  if (bundle.nodeId === undefined || bundle.nodeId === ROOT_RUNTIME_AGENT_NODE_ID) return root;
  const own = bundle.resolvedAgent.config?.approval;
  if (own === undefined) return root;
  return root === undefined ? own : strictestApproval([root, own]);
}
