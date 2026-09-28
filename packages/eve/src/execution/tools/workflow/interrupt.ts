import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };

/**
 * Fires the call's `interruptSignal`. A run that already finished has nothing
 * left to interrupt, so a missing hook is not an error.
 */
export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  await resumeHookStep(run.hookToken, INTERRUPT, { ifPresent: true });
}
