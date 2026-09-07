import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { readWorkflowToolExecutorAddress } from "#execution/tools/workflow/types.js";

export interface TaskExecutorCancelContext {
  readonly entry: SessionTaskIndexEntry;
  readonly serializedContext?: Record<string, unknown>;
  readonly session?: unknown;
}

export type TaskExecutorCancel = (input: TaskExecutorCancelContext) => Promise<void>;

const TASK_RUN_CANCEL_GRACE_MS = 1_000;
const TASK_RUN_CANCEL_POLL_MS = 50;

/** Cancels task-owned work and reports whether the lifecycle run was forcibly stopped. */
export async function cancelTaskOwnedWork(
  input: TaskExecutorCancelContext & { readonly cancelOwnedWork?: TaskExecutorCancel },
): Promise<boolean> {
  const workflowToolRun = readWorkflowToolExecutorAddress(input.entry.executor);
  if (workflowToolRun !== undefined) {
    await cancelWorkflowToolRun(workflowToolRun, `Task ${input.entry.taskId} was cancelled.`);
  }
  await input.cancelOwnedWork?.(input);
  const deadline = Date.now() + TASK_RUN_CANCEL_GRACE_MS;
  while (Date.now() < deadline) {
    try {
      const status = await getRun(input.entry.taskRunId).status;
      if (status !== "pending" && status !== "running") return false;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_RUN_CANCEL_POLL_MS));
  }
  try {
    await cancelRun(await getWorld(), input.entry.taskRunId, {
      cancelReason: `Task ${input.entry.taskId} was cancelled.`,
    });
  } catch {
    // The merged task run may have completed during its cooperative unwind.
  }
  return true;
}
