import type { ContextReader } from "#context/key.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { ApprovalPolicy } from "#approval/definition.js";
import { strictestApproval } from "#approval/agent.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  AgentLimitsDefinition,
  AgentReasoningDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";

export interface AgentSettings {
  readonly compactionModel?: RuntimeModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly thresholdPercent?: number;
}

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

export function agentLimits(
  bundle: Pick<CompiledBundle, "resolvedAgent">,
  ctx: Pick<ContextReader, "get">,
): Pick<AgentLimitsDefinition, "sessionTimeoutMs"> | undefined {
  const config = ctx.get(DynamicSubagentAgentConfigKey);
  return config === undefined ? bundle.resolvedAgent.config?.limits : config.limits;
}

export function resolveSessionUsageLimit(
  bundle: Pick<CompiledBundle, "graph" | "resolvedAgent">,
): SessionUsageLimit | undefined {
  const limit =
    bundle.resolvedAgent.config?.limits?.sessionUsage ??
    bundle.graph.nodesByNodeId.get(ROOT_RUNTIME_AGENT_NODE_ID)?.agent.config?.limits?.sessionUsage;
  return limit === false ? () => false : limit;
}

export function resolveAgentApproval(
  bundle: Pick<CompiledBundle, "graph" | "nodeId" | "resolvedAgent">,
): ApprovalPolicy | undefined {
  const root = bundle.graph.nodesByNodeId.get(ROOT_RUNTIME_AGENT_NODE_ID)?.agent.config?.approval;
  if (bundle.nodeId === undefined || bundle.nodeId === ROOT_RUNTIME_AGENT_NODE_ID) return root;
  const own = bundle.resolvedAgent.config?.approval;
  if (own === undefined) return root;
  return root === undefined ? own : strictestApproval([root, own]);
}
