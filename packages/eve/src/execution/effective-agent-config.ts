import type { ContextReader } from "#context/key.js";
import { AgentSessionRuntimeOverridesKey, DynamicSubagentAgentConfigKey } from "#context/keys.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { AgentLimitsDefinition, SessionUsageLimit } from "#shared/agent-definition.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

interface EffectiveAgentRuntime {
  readonly limits?: AgentLimitsDefinition;
  readonly turnAgent: RuntimeTurnAgent;
}

export function resolveEffectiveAgentRuntime(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  context: ContextReader,
): EffectiveAgentRuntime {
  return resolveEffectiveAgentRuntimeFromConfig(
    bundle,
    context.get(DynamicSubagentAgentConfigKey),
    context.get(AgentSessionRuntimeOverridesKey),
  );
}

/**
 * The session's `limits.sessionUsage`: the agent's own, else the root agent's.
 * A dynamic subagent config can't carry one, so its sessions run the root's.
 */
export function resolveSessionUsageLimit(
  bundle: Pick<CompiledBundle, "graph" | "resolvedAgent">,
): SessionUsageLimit | undefined {
  return (
    bundle.resolvedAgent.config?.limits?.sessionUsage ??
    bundle.graph.nodesByNodeId.get(ROOT_RUNTIME_AGENT_NODE_ID)?.agent.config?.limits?.sessionUsage
  );
}

export function resolveEffectiveAgentRuntimeFromConfig(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  config: DynamicSubagentAgentConfig | undefined,
  overrides?: AgentSessionRuntimeOverrides,
): EffectiveAgentRuntime {
  let effective: EffectiveAgentRuntime;
  if (config === undefined) {
    if (bundle.turnAgent.configResolver === true) {
      throw new Error("Dynamic subagent execution requires a selected concrete agent config.");
    }
    effective = {
      limits: bundle.resolvedAgent.config?.limits,
      turnAgent: bundle.turnAgent,
    };
  } else {
    const {
      configResolver: _configResolver,
      dynamicModel: _dynamicModel,
      model: _compiledModel,
      ...turnAgent
    } = bundle.turnAgent;
    effective = {
      limits: config.limits,
      turnAgent: {
        ...turnAgent,
        model: config.model,
        reasoning: config.reasoning,
      },
    };
  }

  if (overrides === undefined) return effective;
  const {
    configResolver: _configResolver,
    dynamicModel: _dynamicModel,
    model: _configuredModel,
    ...turnAgent
  } = effective.turnAgent;
  return {
    ...effective,
    turnAgent: { ...turnAgent, model: overrides.model },
  };
}
