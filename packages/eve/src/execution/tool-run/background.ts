import { buildCallbackContext } from "#context/build-callback-context.js";
import { startToolRun } from "#execution/tool-run/start.js";
import {
  WORKFLOW_TOOL_EXECUTOR_KIND,
  type WorkflowToolExecutorData,
} from "#execution/tool-run/types.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { parseJsonObject } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskDelegated, TaskExec, TaskExecutorBinding } from "#tools/task.js";

/**
 * The harness-facing `execute` of a background tool whose authored `execute`
 * is a workflow. It runs inside the model step like any background tool,
 * starts the durable run with the task as its owner, and returns the
 * delegation receipt; the run reports completion, failure, progress, and
 * input requests over the task wire from then on.
 */
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
      replyTo: {
        kind: "task",
        taskId: task.task.taskId,
        taskInboxToken: task.task.taskInboxToken,
        taskRunId: task.task.taskRunId,
      },
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

export function createWorkflowToolExecutorBinding(
  data: WorkflowToolExecutorData,
): TaskExecutorBinding {
  return {
    data: { hookToken: data.hookToken, runId: data.runId },
    kind: WORKFLOW_TOOL_EXECUTOR_KIND,
  };
}

/** Reads the tool run recorded on a task's executor binding, if that is what runs it. */
export function readWorkflowToolExecutor(
  binding: TaskExecutorBinding | undefined,
): WorkflowToolExecutorData | undefined {
  if (binding?.kind !== WORKFLOW_TOOL_EXECUTOR_KIND) return undefined;
  const { hookToken, runId } = binding.data;
  return typeof hookToken === "string" && typeof runId === "string"
    ? { hookToken, runId }
    : undefined;
}

/**
 * A run's input crosses the workflow serialization boundary, so the parsed
 * tool input must be a JSON object. Schema parsing can emit other values (a
 * `Date`, for example); those tools cannot be workflows.
 */
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
