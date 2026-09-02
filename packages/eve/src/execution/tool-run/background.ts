import { buildCallbackContext } from "#context/build-callback-context.js";
import { deriveRunOwner } from "#execution/tool-run/messages.js";
import { startToolRun } from "#execution/tool-run/start.js";
import { WORKFLOW_TOOL_EXECUTOR_KIND, type ToolRunAddress } from "#execution/tool-run/types.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { type JsonObject, parseJsonObject } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskDelegated, TaskExec, TaskExecutorBinding } from "#tools/task.js";

/** Harness `execute` for a background workflow tool: starts the run as the task's executor. */
export function createWorkflowToolBackgroundExecute(input: {
  readonly toolName: string;
  readonly workflowId: string;
}): NonNullable<HarnessToolDefinition["execute"]> {
  return async (
    toolInput: unknown,
    options: ToolExecuteOptions,
    task?: TaskExec,
  ): Promise<TaskDelegated> => {
    if (task === undefined) {
      throw new Error(`Background tool "${input.toolName}" requires a task runtime.`);
    }

    const started = await startToolRun({
      callId: options.toolCallId,
      input: parseWorkflowToolInput(toolInput, input.toolName),
      owner: deriveRunOwner(task.task.taskInboxToken),
      session: buildCallbackContext().session,
      stepIndex: getHarnessEmissionState(task.session.state).stepIndex,
      toolName: input.toolName,
      workflowId: input.workflowId,
    });

    return task.delegated({
      executor: createWorkflowToolExecutorBinding(started),
      receipt: {},
    });
  };
}

export function createWorkflowToolExecutorBinding(data: ToolRunAddress): TaskExecutorBinding {
  return {
    data: { hookToken: data.hookToken, runId: data.runId },
    kind: WORKFLOW_TOOL_EXECUTOR_KIND,
  };
}

/** Reads the tool run recorded on a task's executor binding, if that is what runs it. */
export function readWorkflowToolExecutor(
  binding: TaskExecutorBinding | undefined,
): ToolRunAddress | undefined {
  if (binding?.kind !== WORKFLOW_TOOL_EXECUTOR_KIND) return undefined;
  const { hookToken, runId } = binding.data;
  return typeof hookToken === "string" && typeof runId === "string"
    ? { hookToken, runId }
    : undefined;
}

/** The input crosses the run's serialization boundary; a schema may emit a `Date`, which cannot. */
export function parseWorkflowToolInput(toolInput: unknown, toolName: string): JsonObject {
  try {
    return parseJsonObject(toolInput);
  } catch (error) {
    throw new TypeError(
      `Tool "${toolName}" is a workflow, so its parsed input must be a JSON object.`,
      { cause: error },
    );
  }
}
