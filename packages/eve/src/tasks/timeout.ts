import type { ContextReader } from "#context/key.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type { TaskTimeout } from "#shared/task-timeout.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "#tasks/table.js";

/**
 * The time limit for one agent call: the target's authored `timeout`, or the
 * 2-hour default. A local agent's limit comes from its own `agent.ts`; for
 * the built-in `agent` tool the target is the root agent, so the root's
 * `timeout` applies to its copies.
 */
export function resolveAgentTaskTimeout(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextReader;
}): TaskTimeout {
  const { action, bundle } = input;
  const selection =
    bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true
      ? getDynamicSubagentSelection(input.ctx, action.nodeId)
      : undefined;
  const authored =
    selection?.kind === "subagent"
      ? selection.agentConfig.timeout
      : selection?.kind === "remote"
        ? selection.remoteAgent.timeout
        : action.kind === "remote-agent-call"
          ? remoteTimeout(bundle, action.nodeId)
          : bundle.graph?.nodesByNodeId.get(action.nodeId)?.agent.config?.timeout;
  return authored ?? DEFAULT_AGENT_TIMEOUT_MS;
}

function remoteTimeout(bundle: CompiledBundle, nodeId: string): TaskTimeout | undefined {
  const definition = bundle.subagentRegistry.subagentsByNodeId.get(nodeId)?.definition;
  return definition?.kind === "remote" ? definition.timeout : undefined;
}
