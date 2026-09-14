import type { SessionContext } from "#context/session-context.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#tools/task.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";

export type WorkflowToolRunSessionContext = SessionContext["session"];

export const WORKFLOW_TOOL_EXECUTOR_KIND = "workflow-tool";

/** Private task executor binding for the workflow tool run doing the task's work. */
export function createWorkflowToolExecutorBinding(
  input: WorkflowToolRunAddress,
): TaskExecutorBinding {
  return {
    data: { hookToken: input.hookToken, runId: input.runId },
    kind: WORKFLOW_TOOL_EXECUTOR_KIND,
  };
}

export function readWorkflowToolExecutorAddress(
  executor: TaskExecutorBinding | undefined,
): WorkflowToolRunAddress | undefined {
  if (executor?.kind !== WORKFLOW_TOOL_EXECUTOR_KIND) return undefined;
  const hookToken = executor.data.hookToken;
  const runId = executor.data.runId;
  return typeof hookToken === "string" && typeof runId === "string"
    ? { hookToken, runId }
    : undefined;
}

export interface WorkflowToolRunInput {
  readonly callId: string;
  readonly execution?: "background" | "blocking";
  readonly executeInput?: JsonValue;
  readonly hookToken: string;
  readonly input: JsonObject;
  readonly owner: WorkflowToolRunOwner;
  readonly resultKind?: "subagent" | "tool";
  readonly session: WorkflowToolRunSessionContext;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}
