import { activeTurnIdOf } from "#protocol/session-projection.js";
import { queuedInput, storedProjection } from "#harness/session-machine/view.js";
import { openRequests, openSignIns } from "#protocol/session-projection/reader.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { holdsHitlRequests } from "#harness/hitl/view.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  readTaskTable,
  retireIdleResumableTasks,
  writeTaskTable,
  type TaskRunAddress,
} from "#execution/tasks/table.js";

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(input: {
  readonly sessionState: DurableSessionState;
}): boolean {
  const { state } = readDurableSession(input.sessionState);
  // Decoding the run registry rejects corrupt state before any busy-work shortcut.
  const workflowToolRuns = getBlockingWorkflowToolRuns(state);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  if (holdsHitlRequests(state)) return false;
  const projection = storedProjection(state);
  return (
    workflowToolRuns.length === 0 &&
    activeTurnIdOf(projection) === undefined &&
    openRequests(projection.view).length === 0 &&
    openSignIns(projection.view).length === 0 &&
    queuedInput(state) === undefined
  );
}

/**
 * A deployment handoff retires the session's idle resumable tasks: their runs execute the build
 * that started them, so the model's next call to such a subagent or `serve` tool starts a new
 * task on the new build instead. Returns the retired runs, which the successor ends.
 */
export function retireIdleTasksForHandoff<C extends { readonly sessionState: DurableSessionState }>(
  checkpoint: C,
): { readonly checkpoint: C; readonly retiredTaskRuns?: readonly TaskRunAddress[] } {
  const session = readDurableSession(checkpoint.sessionState);
  const { retired, table } = retireIdleResumableTasks(readTaskTable(session.state));
  if (retired.length === 0) return { checkpoint };
  const { sessionState } = checkpoint;
  return {
    checkpoint: {
      ...checkpoint,
      sessionState: {
        ...sessionState,
        snapshot: { ...sessionState.snapshot, session: writeTaskTable(session, table) },
      },
    },
    retiredTaskRuns: retired,
  };
}
