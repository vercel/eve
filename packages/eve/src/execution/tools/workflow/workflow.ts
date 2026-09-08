import { sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { createWorkflowBodyRef, executeWorkflowBody } from "#execution/tools/workflow/body.js";
import { openWorkflowToolRunControlInbox } from "#execution/tools/workflow/run-control.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { codeModeMutableState, diffCodeModeState } from "#execution/code-mode/state.js";

const CANCEL_GRACE = "30s";

/** Runs one authored workflow tool call and reports to its declared owner hook. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const control = openWorkflowToolRunControlInbox(input.hookToken);
  const bodyInput = {
    ...input,
    codeMode: input.codeMode === undefined ? undefined : { ...input.codeMode },
    execution: input.execution ?? "blocking",
  } as const;
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

  // Completed nested calls update this cursor even when another call outlives
  // the cancellation grace period and the body has not returned an outcome.
  if (input.codeMode !== undefined && bodyInput.codeMode !== undefined) {
    const stateChanges = diffCodeModeState(
      codeModeMutableState(input.codeMode),
      codeModeMutableState(bodyInput.codeMode),
    );
    if (stateChanges.length > 0) outcome = { ...outcome, stateChanges };
  }

  const message: WorkflowToolRunOutcomeMessage = { from, result: outcome };
  await resumeHookStep(
    input.owner.inbox,
    { kind: "outcome", ...message },
    {
      ifPresent: outcome.status === "cancelled",
    },
  );
}
