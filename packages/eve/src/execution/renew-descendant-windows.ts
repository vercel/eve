import type { DurableSession } from "#execution/durable-session-store.js";
import { readTaskTable, startedTaskRuns } from "#execution/tasks/table.js";
import { sendToLiveWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/**
 * Tells every running descendant run that an approval started a new usage
 * window, so the sessions they opened start one before their next budget
 * check. A blocking run may not have registered its control hook yet, so a
 * live run is waited for rather than skipped. A task run that hasn't started
 * gets the renewal when it reports started.
 */
export async function renewDescendantWindows(
  session: DurableSession,
  renewalId: string,
): Promise<void> {
  const message: WorkflowToolRunControlMessage = { kind: "renew-window", renewalId };
  const runs = [
    ...startedTaskRuns(readTaskTable(session.state)),
    ...getBlockingWorkflowToolRuns(session.state).map((run) => run.address),
  ];
  await Promise.all(runs.map((run) => sendToLiveWorkflowToolRun(run, message)));
}
