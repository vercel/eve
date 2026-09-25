import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";
import { AGENT_TASK_WORKFLOW_ID } from "#tasks/agent-tool.js";
import { RESUMABLE_TOOL_DESCRIPTION } from "#tasks/render.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#tools/schema.js";
import { withTaskIdParameter } from "#tools/task-id-schema.js";
import type { TaskTimeout } from "#shared/task-timeout.js";

export interface WorkflowToolHarnessDefinitionInput {
  readonly attached?: boolean;
  /** An authored workflow tool whose tasks take sends; every agent tool does. */
  readonly resumable?: boolean;
  readonly definition: HarnessToolDefinition;
  readonly executeInput?: (input: unknown) => JsonValue;
  readonly timeout?: TaskTimeout;
  /** Selected agent definition's runtime graph ID; absent for authored workflow tools. */
  readonly nodeId?: string;

  readonly workflowId: string;
}

/**
 * The harness definition of a tool whose calls start tasks. Every resumable
 * tool, agents included, gets `taskId` once here and one sentence appended
 * to its description; a call with `taskId` is a send. An agent's input
 * schema declares `taskId` itself; an authored workflow tool's schema is
 * wrapped, so the author's schema validates the rest.
 */
export function createWorkflowToolHarnessDefinition(
  input: WorkflowToolHarnessDefinitionInput,
): HarnessToolDefinition {
  const definition = input.definition;
  const agent = input.workflowId === AGENT_TASK_WORKFLOW_ID;
  const resumable = agent || input.resumable === true;
  const workflow = {
    attached: input.attached,
    executeInput: input.executeInput,
    nodeId: input.nodeId,
    resumable: resumable || undefined,
    timeout: input.timeout,
    workflowId: input.workflowId,
  };
  if (!resumable) return { ...definition, ...workflow, execute: undefined };
  return {
    ...definition,
    ...workflow,
    description: `${definition.description.trimEnd()} ${RESUMABLE_TOOL_DESCRIPTION}`,
    execute: undefined,
    inputSchema: agent ? definition.inputSchema : withTaskIdParameter(definition.inputSchema),
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
      inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
      name: tool.name,
      outputSchema: toOutputSchema(tool.outputSchema),
      rootOnly: tool.rootOnly,
    },
    attached: tool.task.attached,
    nodeId: tool.task.nodeId,
    resumable: tool.task.resumable,
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
