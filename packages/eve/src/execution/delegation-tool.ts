import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent } from "#execution/tools/subagent/local.js";
import { defineRemoteSubagent } from "#execution/tools/subagent/remote.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import type { PreparedDispatchTarget } from "#tools/behavior.js";
import {
  UNSPECIFIED_INPUT_SCHEMA,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";

type HarnessDelegationTool = Pick<
  PreparedRuntimeDelegationTool,
  "behavior" | "description" | "name"
> & {
  readonly inputSchema?: ToolSchemaSource | null;
  readonly outputSchema?: ToolSchemaSource | null;
};

type AgentDispatchTarget = Extract<
  PreparedDispatchTarget,
  {
    readonly kind: "remote-agent-call" | "self-agent-call" | "subagent-call";
  }
>;

export function createHarnessDelegationToolDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  return {
    behavior: tool.behavior,
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
  };
}

export function createBackgroundSubagentHarnessDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const target = tool.behavior?.handling;
  if (target?.kind !== "dispatch") {
    throw new Error(`Background subagent tool "${tool.name}" has no prepared dispatch target.`);
  }
  if (target.target.kind === "task-cancel" || target.target.kind === "task-update") {
    throw new Error(
      `Background subagent tool "${tool.name}" cannot dispatch ${target.target.kind}.`,
    );
  }
  const definition = createBackgroundSubagentDefinition({
    description: tool.description ?? "",
    name: tool.name,
    target: target.target,
  });
  const execute = createToolExecuteWithAuth({
    execute: definition.execute,
    execution: definition.execution,
    scope: tool.name,
  });
  return {
    behavior: tool.behavior,
    description: definition.description,
    execute,
    execution: definition.execution,
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema) ?? undefined,
  };
}

function createBackgroundSubagentDefinition(input: {
  readonly description: string;
  readonly name: string;
  readonly target: AgentDispatchTarget;
}) {
  switch (input.target.kind) {
    case "remote-agent-call":
      return defineRemoteSubagent({
        description: input.description,
        name: input.name,
        target: input.target,
      });
    case "self-agent-call":
    case "subagent-call":
      return defineSubagent({
        description: input.description,
        name: input.name,
        target: input.target,
      });
  }
}
