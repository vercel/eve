import { ParentSessionKey } from "#context/keys.js";
import { readDynamicSubagentSelections } from "#definitions/subagents.js";
import type { ContextReader } from "#context/key.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";

/**
 * A compiled agent's delegates for one workflow tool run: its copy (a root session's `agent`
 * tool), its subagents, and the dynamic agents the calling turn selected.
 */
export function compiledDelegates(
  bundle: CompiledBundle,
  ctx: ContextReader,
): Readonly<Record<string, WorkflowAgentMetadata>> {
  const agents = new Map<string, WorkflowAgentMetadata>();

  if (bundle.nodeId === undefined && ctx.get(ParentSessionKey) === undefined) {
    agents.set(AGENT_TOOL_NAME, {
      description: bundle.resolvedAgent.config?.description ?? "",
    });
  }

  for (const [name, registered] of bundle.subagentRegistry.subagentsByName ?? []) {
    const description = registered.definition.description;
    if (description !== undefined) agents.set(name, { description });
  }

  for (const selection of Object.values(readDynamicSubagentSelections(ctx))) {
    agents.set(selection.prepared.name, {
      description:
        selection.kind === "subagent"
          ? selection.agentConfig.description
          : selection.remoteAgent.description,
    });
  }

  return Object.fromEntries(agents);
}
