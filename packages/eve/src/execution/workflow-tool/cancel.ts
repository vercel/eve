import { sendInbox } from "#execution/inbox/send.js";
import type { WorkflowToolRunAddress } from "#execution/workflow-tool/types.js";
import { getRun } from "#internal/workflow/runtime.js";

/** The authored body must finish unwinding before its caller releases ownership. */
export async function cancelWorkflowToolRun(
  run: WorkflowToolRunAddress,
  reason: string,
): Promise<void> {
  await sendInbox(
    { token: run.hookToken, ownerRunId: run.runId },
    { eventId: `${run.runId}:cancel`, kind: "tool.cancel", payload: { reason } },
  );
  await getRun(run.runId).returnValue;
}
