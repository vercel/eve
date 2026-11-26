import { TASK_TOOL_DESCRIPTION } from "#execution/tasks/render.js";
import { withTaskIdInput } from "#execution/tasks/task-id-input.js";
import { entryPointOf } from "#execution/tasks/tool-entry-point.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { workflowIdForHandling } from "#runtime/subagents/workflow-reference.js";
import type { JsonValue } from "#shared/json.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#tools/schema.js";

export interface WorkflowToolHarnessDefinitionInput {
  readonly definition: HarnessToolDefinition;
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly workflowId: string;
}

export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  const entryPoint = entryPointOf(input.definition);
  const definition =
    entryPoint === "serve"
      ? withTaskIdInput(input.definition)
      : entryPoint === "task"
        ? withTaskDescription(input.definition)
        : input.definition;
  return {
    ...definition,
    execute: undefined,
    executeInput: input.executeInput,
    workflowId: input.workflowId,
  };
}

function withTaskDescription(definition: HarnessToolDefinition): HarnessToolDefinition {
  const base = definition.description?.trim();
  if (base?.includes(TASK_TOOL_DESCRIPTION)) return definition;
  return {
    ...definition,
    description: base ? `${base}\n\n${TASK_TOOL_DESCRIPTION}` : TASK_TOOL_DESCRIPTION,
  };
}

export function createPreparedWorkflowToolHarnessDefinition(
  tool: PreparedRuntimeTool,
): HarnessToolDefinition {
  const workflowId = workflowIdForHandling(tool.behavior?.handling);
  if (workflowId === undefined) {
    throw new Error(`Prepared tool "${tool.name}" is not backed by a workflow.`);
  }
  return createWorkflowToolHarnessDefinition({
    definition: {
      frameworkTool: tool.kind !== "authored-tool" || tool.owner.kind === "framework",
      behavior: tool.behavior,
      deferred: tool.deferred,
      description: tool.description,
      inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
      name: tool.name,
      outputSchema: toOutputSchema(tool.outputSchema),
      rootOnly: tool.rootOnly,
      ...(tool.kind === "authored-tool" &&
        tool.workflowProgram !== undefined && { workflowProgram: tool.workflowProgram }),
    },
    workflowId,
  });
}
