import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { hasRunEnded, pollUntil } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };

/** How long a command waits for a run that is still starting to register its control hook. */
const RUN_START_TIMEOUT_MS = 30_000;

/**
 * Aborts the `execute` call's `abortSignal`. A turn steered right after it
 * started the run can get here before the run registers its control hook.
 */
export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  "use step";

  await sendToLiveWorkflowToolRun(run, INTERRUPT);
}

/**
 * Sends a command to a run's control hook. A live run's missing hook is
 * waited for, since the run may still be starting; a run that ended takes
 * nothing. A run still without its hook at the deadline throws, so the
 * calling step fails and the runtime retries it: the command was not
 * delivered. Call from a `"use step"` body.
 */
export async function sendToLiveWorkflowToolRun(
  run: WorkflowToolRunAddress,
  message: WorkflowToolRunControlMessage,
): Promise<void> {
  const settled = await pollUntil(async () => {
    try {
      await resumeHook(run.hookToken, message);
      return true;
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) throw error;
    }
    return (await hasRunEnded(run.runId)) ? true : undefined;
  }, RUN_START_TIMEOUT_MS);
  if (settled === undefined) {
    throw new Error(
      `Workflow tool run "${run.runId}" did not start taking commands within ${RUN_START_TIMEOUT_MS / 1000} seconds, so it has not received the ${message.kind} yet.`,
    );
  }
}
