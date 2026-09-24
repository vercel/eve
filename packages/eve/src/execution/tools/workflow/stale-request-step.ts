import type { WorkflowToolRunRequestMessage } from "#execution/tools/workflow/messages.js";
import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { ToolInputResponse } from "#tools/definition.js";

/**
 * Handles a request the owner does not surface: from a run whose task the
 * owner no longer waits on, such as a cancelled or orphaned run, or an ask
 * refused because its ID is already pending. Nothing reaches the user: a
 * `ctx.ask` question resolves as dismissed so the run can move on, and
 * other requests are dropped.
 */
export async function dismissStaleWorkflowRequestStep(
  message: WorkflowToolRunRequestMessage,
): Promise<void> {
  "use step";

  createLogger("execution.workflow-tool-run").warn(
    "dropped a workflow run's request that the owner does not surface",
    {
      callId: message.from.callId,
      requestKind: message.request.kind,
      runId: message.from.runId,
      taskId: message.from.taskId,
    },
  );
  if (message.request.kind !== "ask") return;
  try {
    const dismissed: ToolInputResponse = { status: "dismissed" };
    await resumeHook(message.replyTo, dismissed);
  } catch (error) {
    if (!isWorkflowTargetGone(error)) throw error;
  }
}
