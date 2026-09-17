import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import type { TaskWorkflowInvocation } from "#harness/workflow-invocations.js";

export interface TaskExecutorCancelContext {
  readonly entry: TaskWorkflowInvocation;
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
  await input.cancelOwnedWork?.(input);
  const deadline = Date.now() + TASK_RUN_CANCEL_GRACE_MS;
  while (Date.now() < deadline) {
    try {
      const status = await getRun(input.entry.address.runId).status;
      if (status !== "pending" && status !== "running") return false;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_RUN_CANCEL_POLL_MS));
  }
  try {
    await cancelRun(await getWorld(), input.entry.address.runId, {
      cancelReason: `Task ${input.entry.task.taskId} was cancelled.`,
    });
  } catch {
    // The merged task run may have completed during its cooperative unwind.
  }
  return true;
}
