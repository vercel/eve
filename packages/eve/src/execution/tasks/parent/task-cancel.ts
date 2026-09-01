import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { readWorkflowToolExecutorAddress } from "#execution/tools/workflow/types.js";

const TASK_RUN_CANCEL_GRACE_MS = 30_000;

export interface TaskExecutorCancelContext {
  readonly entry: SessionTaskIndexEntry;
  readonly serializedContext?: Record<string, unknown>;
  readonly session?: unknown;
}

export type TaskExecutorCancel = (input: TaskExecutorCancelContext) => Promise<void>;

/** Cancels policy-specific work associated with one task. */
export async function cancelTaskOwnedWork(
  input: TaskExecutorCancelContext & { readonly cancelOwnedWork?: TaskExecutorCancel },
): Promise<void> {
  const workflowToolRun = readWorkflowToolExecutorAddress(input.entry.executor);
  if (workflowToolRun !== undefined) {
    await cancelWorkflowToolRun(workflowToolRun, `Task ${input.entry.taskId} was cancelled.`);
  }
  await input.cancelOwnedWork?.(input);
  await new Promise((resolve) => setTimeout(resolve, TASK_RUN_CANCEL_GRACE_MS));
  try {
    await cancelRun(await getWorld(), input.entry.taskRunId, {
      cancelReason: `Task ${input.entry.taskId} was cancelled after its unwind grace period.`,
    });
  } catch {
    // The merged task run may have completed during its cooperative unwind.
  }
}
