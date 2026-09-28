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

/**
 * Workflow tools run outside the model step, so the harness definition carries
 * no `execute`. A `serve` tool's model input gains `taskId`.
 */
export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  const definition =
    entryPointOf(input.definition) === "serve"
      ? withTaskIdInput(input.definition)
      : input.definition;
  return {
    ...definition,
    execute: undefined,
    executeInput: input.executeInput,
    workflowId: input.workflowId,
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
      behavior: tool.behavior,
      description: tool.description,
      inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
      name: tool.name,
      outputSchema: toOutputSchema(tool.outputSchema),
      rootOnly: tool.rootOnly,
    },
    workflowId,
  });
}
