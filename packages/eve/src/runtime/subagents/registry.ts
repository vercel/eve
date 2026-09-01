import { RuntimeRegistry, RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import type {
  ResolvedDynamicSubagentDefinition,
  ResolvedRuntimeDelegationNode,
} from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import { serializeInputSchema } from "#tools/schema.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { subagentToolExecuteWorkflowReference } from "#runtime/subagents/workflow-reference.js";

/**
 * One runtime-owned subagent tracked by the prepared registry.
 */
interface RuntimeRegisteredSubagent {
  readonly definition: ResolvedRuntimeDelegationNode;
  readonly prepared?: PreparedRuntimeDelegationTool;
}

export interface ResolvedDynamicSubagentResolver extends ResolvedDynamicSubagentDefinition {
  readonly kind: "subagent";
  readonly name: string;
  readonly nodeId: string;
}

/**
 * Runtime-owned registry that exposes resolved subagents as model-visible tools.
 */
export interface RuntimeSubagentRegistry {
  readonly dynamicNodeIds: ReadonlySet<string>;
  readonly dynamicResolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly preparedTools: readonly PreparedRuntimeDelegationTool[];
  readonly subagentsByName: ReadonlyMap<string, RuntimeRegisteredSubagent>;
  readonly subagentsByNodeId: ReadonlyMap<string, RuntimeRegisteredSubagent>;
}

/**
 * Stable input schema lowered onto every subagent tool. Subagents always
 * accept one free-form `message` string from the parent agent.
 */
const SUBAGENT_TOOL_INPUT_JSON_SCHEMA = serializeInputSchema(SUBAGENT_TOOL_INPUT_SCHEMA);

/**
 * Builds the runtime-owned registry for the resolved subagents visible from one
 * runtime agent node.
 */
export function createRuntimeSubagentRegistry(input: {
  readonly reservedToolNames?: readonly string[];
  readonly subagents: readonly ResolvedRuntimeDelegationNode[];
}): RuntimeSubagentRegistry {
  const preparedTools: PreparedRuntimeDelegationTool[] = [];
  const dynamicNodeIds = new Set<string>();
  const dynamicResolvers: ResolvedDynamicSubagentResolver[] = [];
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

    let registeredSubagent: RuntimeRegisteredSubagent;
    const dynamic = subagentDefinition.kind === "subagent" ? subagentDefinition.dynamic : undefined;
    if (dynamic === undefined) {
      const prepared = createPreparedRuntimeSubagentTool(
        subagentDefinition,
        SUBAGENT_TOOL_INPUT_JSON_SCHEMA,
      );
      registeredSubagent = {
        definition: subagentDefinition,
        prepared,
      };
      registry.register(subagentDefinition.name, registeredSubagent, {
        location,
        duplicateMessage: `Found multiple subagents named "${subagentDefinition.name}". Subagent names must be unique at runtime.`,
        reservedMessage: `Subagent "${subagentDefinition.name}" collides with another runtime-visible tool name.`,
      });
      preparedTools.push(prepared);
    } else {
      dynamicNodeIds.add(subagentDefinition.nodeId);
      dynamicResolvers.push({
        ...dynamic,
        kind: "subagent",
        logicalPath: subagentDefinition.logicalPath,
        name: subagentDefinition.name,
        nodeId: subagentDefinition.nodeId,
        sourceId: subagentDefinition.sourceId,
        sourceKind: "module",
      });
      registeredSubagent = {
        definition: subagentDefinition,
      };
    }
    subagentsByNodeId.set(subagentDefinition.nodeId, registeredSubagent);
  }

  return {
    dynamicNodeIds,
    dynamicResolvers,
    preparedTools,
    subagentsByName: registry.asMap(),
    subagentsByNodeId,
  };
}

export function createPreparedRuntimeSubagentTool(
  definition: ResolvedRuntimeDelegationNode,
  inputSchema: JsonObject = SUBAGENT_TOOL_INPUT_JSON_SCHEMA,
): PreparedRuntimeDelegationTool {
  if (definition.description === undefined) {
    throw new Error(`Static subagent "${definition.name}" is missing a description.`);
  }
  return {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target:
          definition.kind === "remote"
            ? {
                kind: "remote-agent-call",
                nodeId: definition.nodeId,
                remoteAgentName: definition.name,
              }
            : {
                kind: "subagent-call",
                nodeId: definition.nodeId,
                subagentName: definition.name,
              },
      },
    },
    description: definition.description,
    execution: "background",
    inputSchema,
    kind: definition.kind,
    logicalPath: definition.logicalPath,
    name: definition.name,
    nodeId: definition.nodeId,
    outputSchema: definition.kind === "remote" ? definition.outputSchema : undefined,
    sourceId: definition.sourceId,
    task: {
      nodeId: definition.nodeId,
      resultKind: "subagent",
      workflowId: subagentToolExecuteWorkflowReference.workflowId,
    },
  };
}
