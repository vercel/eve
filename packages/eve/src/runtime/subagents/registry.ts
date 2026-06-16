import { RuntimeRegistry, RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { JsonObject } from "#shared/json.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import type { ResolvedRuntimeDelegationNode } from "#runtime/types.js";

/**
 * One runtime-owned subagent tracked by the prepared registry.
 */
interface RuntimeRegisteredSubagent {
  readonly definition: ResolvedRuntimeDelegationNode;
  readonly prepared: PreparedRuntimeDelegationTool;
}

/**
 * Runtime-owned registry that exposes resolved subagents as model-visible tools.
 */
export interface RuntimeSubagentRegistry {
  readonly preparedTools: readonly PreparedRuntimeDelegationTool[];
  readonly subagentsByName: ReadonlyMap<string, RuntimeRegisteredSubagent>;
  readonly subagentsByNodeId: ReadonlyMap<string, RuntimeRegisteredSubagent>;
}

/**
 * Stable JSON Schema lowered onto every subagent tool. Subagents always
 * accept one free-form `message` string from the parent agent.
 */
export const SUBAGENT_TOOL_INPUT_SCHEMA: JsonObject = Object.freeze({
  type: "object",
  properties: Object.freeze({
    message: Object.freeze({
      type: "string",
      description:
        "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    }),
    outputSchema: Object.freeze({
      type: "object",
      description:
        "When provided, the subagent runs in task mode and must produce structured output matching this JSON Schema. The structured output becomes the tool result.",
    }),
  }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
}) as JsonObject;

/**
 * Builds the runtime-owned registry for the resolved subagents visible from one
 * runtime agent node.
 */
export function createRuntimeSubagentRegistry(input: {
  readonly reservedToolNames?: readonly string[];
  readonly subagents: readonly ResolvedRuntimeDelegationNode[];
}): RuntimeSubagentRegistry {
  const preparedTools: PreparedRuntimeDelegationTool[] = [];
  const registry = new RuntimeRegistry<RuntimeRegisteredSubagent>(
    "subagent",
    input.reservedToolNames ?? [],
  );
  const subagentsByNodeId = new Map<string, RuntimeRegisteredSubagent>();

  for (const subagentDefinition of input.subagents) {
    const location = {
      logicalPath: subagentDefinition.logicalPath,
      sourceId: subagentDefinition.sourceId,
    };

    if (subagentsByNodeId.has(subagentDefinition.nodeId)) {
      throw new RuntimeRegistryError(
        "subagent",
        `Found multiple runtime subagents mapped to node id "${subagentDefinition.nodeId}".`,
        { ...location, entryName: subagentDefinition.name },
      );
    }

    const prepared = createPreparedRuntimeSubagentTool(subagentDefinition);
    const registeredSubagent: RuntimeRegisteredSubagent = {
      definition: subagentDefinition,
      prepared,
    };

    registry.register(subagentDefinition.name, registeredSubagent, {
      location,
      duplicateMessage: `Found multiple subagents named "${subagentDefinition.name}". Subagent names must be unique at runtime.`,
      reservedMessage: `Subagent "${subagentDefinition.name}" collides with another runtime-visible tool name.`,
    });

    preparedTools.push(prepared);
    subagentsByNodeId.set(subagentDefinition.nodeId, registeredSubagent);
  }

  return {
    preparedTools,
    subagentsByName: registry.asMap(),
    subagentsByNodeId,
  };
}

function createPreparedRuntimeSubagentTool(
  definition: ResolvedRuntimeDelegationNode,
): PreparedRuntimeDelegationTool {
  return {
    description: definition.description,
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
    kind: definition.kind,
    logicalPath: definition.logicalPath,
    name: definition.name,
    nodeId: definition.nodeId,
    outputSchema: definition.kind === "remote" ? definition.outputSchema : undefined,
    sourceId: definition.sourceId,
  };
}
