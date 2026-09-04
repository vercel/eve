import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { cancelWorkflowToolRun } from "#execution/workflow-tool/cancel.js";
import { readWorkflowToolExecutorAddress } from "#execution/workflow-tool/types.js";

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
}
