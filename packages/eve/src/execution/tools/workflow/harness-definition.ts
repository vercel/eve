import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#tools/schema.js";
import type { TaskTimeout } from "#shared/task-timeout.js";

export interface WorkflowToolHarnessDefinitionInput {
  readonly attached?: boolean;
  readonly definition: HarnessToolDefinition;
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly timeout?: TaskTimeout;
  /** Selected agent definition's runtime graph ID; absent for authored workflow tools. */
  readonly nodeId?: string;

  readonly workflowId: string;
}

export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  const definition = input.definition;
  const workflow = {
    attached: input.attached,
    executeInput: input.executeInput,
    nodeId: input.nodeId,
    timeout: input.timeout,
    workflowId: input.workflowId,
  };
  return { ...definition, ...workflow, execute: undefined };
}

export function createPreparedWorkflowToolHarnessDefinition(
  tool: PreparedRuntimeTool,
): HarnessToolDefinition {
  if (tool.task === undefined) {
    throw new Error(`Prepared tool "${tool.name}" is not backed by a workflow task.`);
  }
  const input: {
    -readonly [
      K in keyof WorkflowToolHarnessDefinitionInput
    ]: WorkflowToolHarnessDefinitionInput[K];
  } = {
    definition: {
      behavior: tool.behavior,
      description: tool.description,
      inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
      name: tool.name,
      outputSchema: toOutputSchema(tool.outputSchema),
      rootOnly: tool.rootOnly,
    },
    attached: tool.task.attached,
    nodeId: tool.task.nodeId,
    timeout: tool.task.timeout,
    workflowId: tool.task.workflowId,
  };
  return createWorkflowToolHarnessDefinition(input);
}

export function parseWorkflowToolInput(
  toolInput: unknown,
  toolName: string,
): ReturnType<typeof parseJsonObject> {
  try {
    return parseJsonObject(toolInput);
  } catch (error) {
    throw new TypeError(
      `Tool "${toolName}" is a workflow, so its parsed input must be a JSON object.`,
      { cause: error },
    );
  }
}
