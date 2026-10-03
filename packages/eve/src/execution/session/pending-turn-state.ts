import { getPendingCoordinationBatch, pendingCoordinationCallIds } from "#harness/coordination.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";

/** Derives the workflow fields used to select the next action at the park boundary. */
export function derivePendingState(session: HarnessSession): {
  /** The pending batch has workflow tool runs to start; task tool calls are answered by the session. */
  readonly hasRunsToDispatch?: boolean;
  readonly pendingCoordinationCallIds?: readonly string[];
  readonly pendingTaskToolCalls?: readonly TaskToolCall[];
} {
  const batch = getPendingCoordinationBatch(session.state);
  if (batch === undefined) return {};
  return {
    hasRunsToDispatch: batch.tasks.length > 0,
    pendingCoordinationCallIds: pendingCoordinationCallIds(batch),
    pendingTaskToolCalls: pendingTaskToolCalls(batch.responseMessages),
  };
}
