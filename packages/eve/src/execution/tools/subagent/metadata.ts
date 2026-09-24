import {
  ParentSessionKey,
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentSelection,
} from "#context/keys.js";
import type { ContextReader } from "#context/key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";

/** Snapshots callable agent metadata for one workflow tool run. */
export function resolveWorkflowAgentMetadata(
  ctx: ContextReader,
): Readonly<Record<string, WorkflowAgentMetadata>> {
  const bundle = ctx.get(BundleKey);
  if (bundle === undefined) return {};
  const agents = new Map<string, WorkflowAgentMetadata>();

  if (bundle.nodeId === undefined && ctx.get(ParentSessionKey) === undefined) {
    agents.set(AGENT_TOOL_NAME, {
      description: bundle.resolvedAgent.config?.description ?? "",
    });
  }

  for (const [name, registered] of bundle.subagentRegistry.subagentsByName ?? []) {
    const { definition } = registered;
    if (definition.description === undefined) continue;
    const choices = definition.kind === "subagent" ? definition.modelChoices : undefined;
    agents.set(
      name,
      choices === undefined
        ? { description: definition.description }
        : {
            description: definition.description,
            models: Object.fromEntries(
              choices.map((choice) => [
                choice.id,
                choice.description === undefined ? {} : { description: choice.description },
              ]),
            ),
          },
    );
  }

  const selections = effectiveDynamicSelections(ctx);
  for (const selection of Object.values(selections)) {
    if (selection === null) continue;
    agents.set(selection.prepared.name, {
      description:
        selection.kind === "subagent"
          ? selection.agentConfig.description
          : selection.remoteAgent.description,
    });
  }

  return Object.fromEntries(agents);
}

function effectiveDynamicSelections(
  ctx: ContextReader,
): Readonly<Record<string, DurableDynamicSubagentSelection>> {
  return {
    ...ctx.get(SessionDynamicSubagentSelectionsKey),
    ...ctx.get(TurnDynamicSubagentSelectionsKey),
  };
}
