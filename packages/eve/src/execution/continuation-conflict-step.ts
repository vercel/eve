import { isInactiveWorkflowRunError } from "#internal/workflow/is-inactive-workflow-run-error.js";

import type { SessionCommand } from "#channel/types.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";

/** Settles side effects owned by a session candidate that lost its continuation claim. */
export async function settleContinuationConflictStep(input: {
  readonly activityCollectorRunId?: string;
  readonly command?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly continuationToken: string;
}): Promise<void> {
  "use step";

  try {
    if (input.command !== undefined) {
      await resumeSessionInbox(input.continuationToken, input.command);
    }
  } finally {
    if (input.activityCollectorRunId !== undefined) {
      await cancelCollector(input.activityCollectorRunId);
    }
  }
}

async function cancelCollector(runId: string): Promise<void> {
  try {
    await cancelRun(await getWorld(), runId, {
      cancelReason: "Session candidate did not acquire continuation ownership",
    });
  } catch (error) {
    if (!isInactiveWorkflowRunError(error)) throw error;
  }
}
