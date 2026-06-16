import { RuntimeRegistry } from "#internal/runtime-registry.js";
import type { PreparedRuntimeAuthoredTool } from "#runtime/sessions/turn.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

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
    readonly reservedToolNames?: readonly string[];
  } = {},
): Promise<RuntimeToolRegistry> {
  const preparedTools: PreparedRuntimeAuthoredTool[] = [];
  const registry = new RuntimeRegistry<RuntimeRegisteredTool>(
    "tool",
    input.reservedToolNames ?? [],
  );

  for (const toolDefinition of definitions.tools) {
    const prepared = await createPreparedRuntimeTool(toolDefinition);
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
): Promise<PreparedRuntimeAuthoredTool> {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema,
    kind: "authored-tool",
    logicalPath: definition.logicalPath,
    name: definition.name,
    outputSchema: definition.outputSchema,
    sourceId: definition.sourceId,
  };
}
