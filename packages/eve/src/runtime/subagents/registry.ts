import { z } from "#compiled/zod/index.js";

import { RuntimeRegistry, RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import type {
  ResolvedDynamicSubagentDefinition,
  ResolvedRuntimeDelegationNode,
} from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import { serializeInputSchema } from "#shared/tool-schema.js";

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
export const SUBAGENT_TOOL_INPUT_SCHEMA = z.strictObject({
  message: z
    .string()
    .describe(
      "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    ),
  outputSchema: z
    .looseObject({})
    .describe(
      "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The subagent must match a provided schema, and that structured output becomes the tool result.",
    )
    .optional(),
});

/**
 * Extended subagent tool input schema for agents that opt into
 * `experimental.subagentPersistentSessions`: adds the `agentId` field the
 * model uses to continue a previous delegation.
 */
export const PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA = SUBAGENT_TOOL_INPUT_SCHEMA.extend({
  agentId: z
    .string()
    .nullable()
    .describe(
      "Only pass this to continue a previous delegation: the id of an agent from the <agents> list. To start a new agent — the common case — omit this field entirely (or pass null or an empty string).",
    )
    .optional(),
});

const SUBAGENT_TOOL_INPUT_JSON_SCHEMA = serializeInputSchema(SUBAGENT_TOOL_INPUT_SCHEMA);

const PERSISTENT_SUBAGENT_TOOL_INPUT_JSON_SCHEMA = serializeInputSchema(
  PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
);

/** Selects the serialized subagent tool input schema for one agent's opt-in state. */
export function getSubagentToolInputJsonSchema(persistentSessions: boolean): JsonObject {
  return persistentSessions
    ? PERSISTENT_SUBAGENT_TOOL_INPUT_JSON_SCHEMA
    : SUBAGENT_TOOL_INPUT_JSON_SCHEMA;
}

/**
 * Builds the runtime-owned registry for the resolved subagents visible from one
 * runtime agent node.
 */
export function createRuntimeSubagentRegistry(input: {
  /**
   * Whether the owning agent opted into
   * `experimental.subagentPersistentSessions`. Adds the model-visible
   * `agentId` continuation field to every lowered subagent tool schema.
   */
  readonly persistentSessions?: boolean;
  readonly reservedToolNames?: readonly string[];
  readonly subagents: readonly ResolvedRuntimeDelegationNode[];
}): RuntimeSubagentRegistry {
  const inputSchema = getSubagentToolInputJsonSchema(input.persistentSessions === true);
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
      const prepared = createPreparedRuntimeSubagentTool(subagentDefinition, inputSchema);
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
    description: definition.description,
    inputSchema,
    kind: definition.kind,
    logicalPath: definition.logicalPath,
    name: definition.name,
    nodeId: definition.nodeId,
    outputSchema: definition.kind === "remote" ? definition.outputSchema : undefined,
    sourceId: definition.sourceId,
  };
}
