import { getWorkflowMetadata, sleep as workflowSleep } from "#compiled/@workflow/core/index.js";
import { publishWorkflowOwnershipStep } from "#execution/workflow-lifecycle-step.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { createWorkflowBodyRef, executeWorkflowBody } from "#execution/tools/workflow/body.js";
import { openWorkflowToolRunControlInbox } from "#execution/tools/workflow/run-control.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";

const CANCEL_GRACE = "30s";

/** Runs one authored workflow tool call and reports to its declared owner hooks. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const control = openWorkflowToolRunControlInbox(input.hookToken);
  let ownsInbox = false;
  try {
    try {
      await claimHookOwnership(control.hook);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error) && typeof error.conflictingRunId === "string") {
        await publishWorkflowOwnershipStep({ runId: error.conflictingRunId });
        return;
      }
      throw error;
    }

    await publishWorkflowOwnershipStep({ runId: getWorkflowMetadata().workflowRunId });
    const bodyInput = { ...input, execution: input.execution ?? "blocking" } as const;
    const from = createWorkflowBodyRef(bodyInput);
    const body = executeWorkflowBody(bodyInput, control.signal).then(({ outcome }) => {
      if (outcome.status === "completed") return outcome.output;
      if (outcome.status === "failed") throw outcome.error;
      throw control.signal.reason ?? new Error(outcome.reason ?? "Workflow tool run cancelled.");
    });
    const settled = body.catch(() => {});
    let outcome: WorkflowToolRunOutcome;
    try {
      outcome = { output: await Promise.race([body, control.cancelled]), status: "completed" };
    } catch (error) {
      if (!control.signal.aborted) {
        outcome = { error: normalizeSerializableError(error), status: "failed" };
      } else {
        await Promise.race([settled, workflowSleep(CANCEL_GRACE)]);
        outcome = { reason: control.reason(), status: "cancelled" };
      }
    }

    const message: WorkflowToolRunOutcomeMessage = { from, result: outcome };
    await resumeHookStep(input.owner.outcome, message, {
      ifPresent: outcome.status === "cancelled",
    });
  } finally {
    if (ownsInbox) await disposeHook(control.hook);
  }
}
