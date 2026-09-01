import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#tools/schema.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";

export interface WorkflowToolHarnessDefinitionInput {
  readonly definition: HarnessToolDefinition;
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly nodeId?: string;
  readonly resultKind?: "subagent" | "tool";
  readonly workflowId: string;
}

export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  const definition =
    input.resultKind === "subagent"
      ? {
          ...input.definition,
          description: `${input.definition.description}\n\nThis call starts a background task and returns a task receipt immediately.`,
          outputSchema: toOutputSchema(SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA),
        }
      : input.definition;
  const workflow = {
    executeInput: input.executeInput,
    nodeId: input.nodeId,
    resultKind: input.resultKind,
    workflowId: input.workflowId,
  };
  if (definition.execution !== "background") {
    return { ...definition, ...workflow, execute: undefined };
  }
  return {
    ...definition,
    ...workflow,
    execute: createWorkflowToolBackgroundExecute({
      toolName: definition.name,
      workflowId: input.workflowId,
    }),
  };
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
      execution: tool.execution,
      inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
      name: tool.name,
      outputSchema: toOutputSchema(tool.outputSchema),
      rootOnly: tool.rootOnly,
    },
    nodeId: tool.task.nodeId,
    resultKind: tool.task.resultKind,
    workflowId: tool.task.workflowId,
  };
  return createWorkflowToolHarnessDefinition(input);
}

/** Returns a task receipt after the background scope starts the owning run. */
export function createWorkflowToolBackgroundExecute(input: {
  readonly toolName: string;
  readonly workflowId: string;
}): NonNullable<HarnessToolDefinition["execute"]> {
  return (_toolInput: unknown, _options: ToolExecuteOptions, _task?: TaskExec): never => {
    throw new Error(
      `Background workflow tool "${input.toolName}" must be started by the task runtime (${input.workflowId}).`,
    );
  };
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
