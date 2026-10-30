import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { hasRunEnded, pollUntil } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };

/** How long a steered turn waits for a run that is still starting to take its interrupt. */
const RUN_START_TIMEOUT_MS = 30_000;

/**
 * Aborts the `execute` call's `abortSignal`. A turn steered right after it
 * started the run can get here before the run registers its control hook, so
 * a live run's missing hook is waited for. A run that ended has nothing left
 * to interrupt. A run still without its hook at the deadline fails the step,
 * which the runtime retries, since the interrupt was not delivered.
 */
export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  "use step";

  const settled = await pollUntil(async () => {
    try {
      await resumeHook(run.hookToken, INTERRUPT);
      return true;
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) throw error;
    }
    return (await hasRunEnded(run.runId)) ? true : undefined;
  }, RUN_START_TIMEOUT_MS);
  if (settled === undefined) {
    throw new Error(
      `Workflow tool run "${run.runId}" did not start taking commands within ${RUN_START_TIMEOUT_MS / 1000} seconds, so it has not received the interrupt yet.`,
    );
  }
}
