import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import type { JsonValue } from "#shared/json.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#tools/schema.js";

export interface WorkflowToolHarnessDefinitionInput {
  readonly definition: HarnessToolDefinition;
  readonly executeInput?: (input: unknown) => JsonValue;
  /** Selected agent definition's runtime graph ID; absent for authored workflow tools. */
  readonly nodeId?: string;

  readonly workflowId: string;
}

/** Workflow tools run outside the model step, so the harness definition carries no `execute`. */
export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  return {
    ...input.definition,
    execute: undefined,
    executeInput: input.executeInput,
    nodeId: input.nodeId,
    workflowId: input.workflowId,
  };
}

export function createPreparedWorkflowToolHarnessDefinition(
  tool: PreparedRuntimeTool,
): HarnessToolDefinition {
  if (tool.task === undefined) {
    throw new Error(`Prepared tool "${tool.name}" is not backed by a workflow task.`);
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
    nodeId: tool.task.nodeId,
    workflowId: tool.task.workflowId,
  });
}
