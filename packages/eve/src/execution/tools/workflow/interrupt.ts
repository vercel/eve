import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { SESSION_HOOK_HANDOVER_TIMEOUT_MS } from "#execution/session-inbox/hook-release.js";
import { hasRunEnded } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };

/**
 * Aborts the `execute` call's `abortSignal`. A turn steered right after it
 * started the run can get here before the run registers its control hook, so
 * a live run's missing hook is waited for. A run that ended has nothing left
 * to interrupt.
 */
export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  "use step";

  const deadline = Date.now() + SESSION_HOOK_HANDOVER_TIMEOUT_MS;
  for (let delayMs = 20; ; delayMs = Math.min(delayMs * 2, 200)) {
    try {
      await resumeHook(run.hookToken, INTERRUPT);
      return;
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) throw error;
    }
    if (Date.now() >= deadline || (await hasRunEnded(run.runId))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
