import type { SessionStateMap } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import type { AgentTaskCall } from "#tasks/owner.js";

/**
 * Marks model tools whose calls start an agent task (declared, remote,
 * dynamic, and the built-in `agent`). It defers the call like a workflow
 * tool, but the owner starts the child session directly; nothing with this
 * ID is ever started as a workflow.
 */
export const AGENT_TASK_WORKFLOW_ID = "eve//agent-task";

export function isAgentTaskRequest(
  request: Pick<RuntimeWorkflowTaskRequest, "workflowId">,
): boolean {
  return request.workflowId === AGENT_TASK_WORKFLOW_ID;
}

/** Reads one model agent call. The tool name is the agent's name; a `taskId` makes it a send. */
export function agentTaskCallFromRequest(request: RuntimeWorkflowTaskRequest): AgentTaskCall {
  const { message, outputSchema } = request.input;
  const input: { taskId?: string; message: string; outputSchema?: JsonObject; target: string } = {
    message: typeof message === "string" ? message : "",
    target: request.toolName,
  };
  if (request.taskId !== undefined) input.taskId = request.taskId;
  if (typeof outputSchema === "object" && outputSchema !== null && !Array.isArray(outputSchema)) {
    input.outputSchema = outputSchema as JsonObject;
  }
  return { callId: request.callId, input, toolName: request.toolName };
}

/**
 * Whether the pending coordination batch holds agent calls. The session
 * workflow body reads this raw so it does not import the harness.
 */
export function hasPendingAgentTaskCalls(state: SessionStateMap | undefined): boolean {
  const batch = state?.["eve.runtime.pendingCoordinationBatch"];
  if (typeof batch !== "object" || batch === null) return false;
  const tasks = (batch as { readonly tasks?: unknown }).tasks;
  return (
    Array.isArray(tasks) &&
    tasks.some(
      (task: unknown) =>
        typeof task === "object" &&
        task !== null &&
        (task as { readonly workflowId?: unknown }).workflowId === AGENT_TASK_WORKFLOW_ID,
    )
  );
}
