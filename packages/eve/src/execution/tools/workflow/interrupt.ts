import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunAddress } from "#execution/tools/workflow/types.js";
import { isRunTargetGone } from "#shared/run-errors.js";
import { pollUntil } from "#shared/poll-until.js";
import { resumeRoutedHook, routedRunEnded } from "#execution/hosts.js";

const INTERRUPT: WorkflowToolRunControlMessage = { kind: "interrupt" };

const RUN_START_TIMEOUT_MS = 30_000;

export async function interruptWorkflowToolRun(run: WorkflowToolRunAddress): Promise<void> {
  "use step";

  const settled = await pollUntil(async () => {
    try {
      await resumeRoutedHook(run.hookToken, INTERRUPT);
      return true;
    } catch (error) {
      if (!isRunTargetGone(error)) throw error;
    }
    return (await routedRunEnded(run.runId)) ? true : undefined;
  }, RUN_START_TIMEOUT_MS);
  if (settled === undefined) {
    throw new Error(
      `Workflow tool run "${run.runId}" did not start taking commands within ${RUN_START_TIMEOUT_MS / 1000} seconds, so it has not received the interrupt yet.`,
    );
  }
}
