import type { WorkflowToolRunRequestMessage } from "#execution/tools/workflow/messages.js";
import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { ToolInputResponse } from "#tools/definition.js";

/**
 * Handles a request from a run whose task the owner no longer waits on,
 * such as a cancelled or orphaned run. Nothing reaches the user: a
 * `ctx.ask` question resolves as dismissed so the run can unwind, and other
 * requests are dropped.
 */
export async function dismissStaleWorkflowRequestStep(
  message: WorkflowToolRunRequestMessage,
): Promise<void> {
  "use step";

  createLogger("execution.workflow-tool-run").warn(
    "dropped a request from a workflow run whose task is no longer working",
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
