import { RuntimeRegistry } from "#internal/runtime-registry.js";
import type { PreparedRuntimeAuthoredTool } from "#runtime/sessions/turn.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { serializeInputSchema, serializeOutputSchema } from "#tools/schema.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { subagentToolExecuteWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import type {
  CompiledToolBehavior,
  PreparedToolBehavior,
  PreparedToolHandling,
} from "#tools/behavior.js";

/**
 * One executable authored tool tracked by the runtime-owned registry.
 */
interface RuntimeRegisteredTool {
  readonly definition: ResolvedToolDefinition;
  readonly prepared: PreparedRuntimeAuthoredTool;
}

/**
 * Runtime-owned tool registry used to expose authored tools to the harness and
 * execute them later inside framework-owned steps.
 */
export interface RuntimeToolRegistry {
  readonly preparedTools: readonly PreparedRuntimeAuthoredTool[];
  readonly toolsByName: ReadonlyMap<string, RuntimeRegisteredTool>;
}

/**
 * Builds the runtime-owned registry for one resolved authored agent.
 */
export async function createRuntimeToolRegistry(
  definitions: {
    readonly tools: readonly ResolvedToolDefinition[];
  },
  input: {
    readonly nodeId?: string;
    readonly reservedToolNames?: readonly string[];
  } = {},
): Promise<RuntimeToolRegistry> {
  const preparedTools: PreparedRuntimeAuthoredTool[] = [];
  const registry = new RuntimeRegistry<RuntimeRegisteredTool>(
    "tool",
    input.reservedToolNames ?? [],
  );

  for (const toolDefinition of definitions.tools) {
    const prepared = await createPreparedRuntimeTool(toolDefinition, input.nodeId);
    registry.register(
      toolDefinition.name,
      { definition: toolDefinition, prepared },
      {
        location: {
          logicalPath: toolDefinition.logicalPath,
          sourceId: toolDefinition.sourceId,
        },
        duplicateMessage: `Found multiple authored tools named "${toolDefinition.name}". Tool names must be unique at runtime.`,
        reservedMessage: `Tool "${toolDefinition.name}" collides with another runtime-visible tool name.`,
      },
    );
    preparedTools.push(prepared);
  }

  return {
    preparedTools,
    toolsByName: registry.asMap(),
  };
}

/**
 * Looks up one authored tool by name from the runtime-owned registry.
 */
export function findRegisteredRuntimeTool(
  registry: RuntimeToolRegistry,
  toolName: string,
): RuntimeRegisteredTool | null {
  return registry.toolsByName.get(toolName) ?? null;
}

async function createPreparedRuntimeTool(
  definition: ResolvedToolDefinition,
  nodeId: string | undefined,
): Promise<PreparedRuntimeAuthoredTool> {
  const isFrameworkAgent =
    definition.owner.kind === "framework" && definition.name === AGENT_TOOL_NAME;
  const workflowId = isFrameworkAgent
    ? subagentToolExecuteWorkflowReference.workflowId
    : definition.behavior?.handling?.kind === "workflow-tool"
      ? definition.behavior.handling.workflowId
      : undefined;
  return {
    behavior: prepareToolBehavior(
      definition.behavior,
      nodeId,
      isFrameworkAgent ? subagentToolExecuteWorkflowReference.workflowId : undefined,
    ),
    description: definition.description,
    execution: definition.execution,
    inputSchema: serializeInputSchema(definition.inputSchema),
    kind: "authored-tool",
    logicalPath: definition.logicalPath,
    name: definition.name,
    owner: definition.owner,
    outputSchema: serializeOutputSchema(definition.outputSchema),
    rootOnly: isFrameworkAgent || undefined,
    sourceId: definition.sourceId,
    task:
      workflowId === undefined
        ? undefined
        : isFrameworkAgent
          ? {
              nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
              resultKind: "subagent",
              workflowId,
            }
          : { workflowId },
  };
}

function prepareToolBehavior(
  behavior: CompiledToolBehavior | undefined,
  nodeId: string | undefined,
  workflowIdOverride?: string,
): PreparedToolBehavior | undefined {
  if (behavior === undefined) return undefined;

  let handling: PreparedToolHandling | undefined;
  if (workflowIdOverride !== undefined && nodeId !== undefined) {
    handling = {
      kind: "dispatch",
      target: { kind: "self-agent-call", nodeId, subagentName: AGENT_TOOL_NAME },
    };
  } else if (behavior.handling?.kind === "dispatch") {
    if (behavior.handling.action === "self-agent" && nodeId === undefined) {
      throw new Error("The self-agent tool requires a concrete runtime node id.");
    }
    const target =
      behavior.handling.action === "self-agent"
        ? {
            kind: "self-agent-call" as const,
            nodeId: nodeId!,
            subagentName: AGENT_TOOL_NAME,
          }
        : { kind: behavior.handling.action };
    handling = { kind: "dispatch", target };
  } else if (behavior.handling?.kind === "workflow-tool") {
    handling = {
      kind: "dispatch",
      target: {
        kind: "workflow-tool-call",
        workflowId: workflowIdOverride ?? behavior.handling.workflowId,
      },
    };
  } else {
    handling = behavior.handling;
  }

  return {
    availability: behavior.availability,
    handling,
    presentation: behavior.presentation,
  };
}
