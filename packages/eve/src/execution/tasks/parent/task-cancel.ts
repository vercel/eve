import type { HarnessSession } from "#harness/types.js";
import { settleWorkflowToolRunCancellation } from "#execution/tools/workflow/cancel.js";
import type { TaskWorkflowInvocation } from "#harness/workflow-invocations.js";

export interface TaskExecutorCancelContext {
  readonly entry: TaskWorkflowInvocation;
  readonly serializedContext?: Record<string, unknown>;
  readonly session?: Pick<HarnessSession, "state">;
}

export type TaskExecutorCancel = (input: TaskExecutorCancelContext) => Promise<void>;

/** Cancels task-owned work and waits for the invocation cleanup boundary. */
export async function cancelTaskOwnedWork(
  input: TaskExecutorCancelContext & { readonly cancelOwnedWork?: TaskExecutorCancel },
): Promise<void> {
  await input.cancelOwnedWork?.(input);
  await settleWorkflowToolRunCancellation(
    input.entry.address.runId,
    `Task ${input.entry.task.taskId} was cancelled.`,
  );
}
