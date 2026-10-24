import type { SessionReading } from "#execution/session/scheduler/next.js";
import { readTaskTable, summarizeTasks } from "#execution/tasks/table.js";
import { activeTurnId, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/**
 * What the scheduler reads of a session: what its durable `state` holds, and what only the world
 * around the session knows, such as who its context acts as.
 */
export function sessionReading(
  state: SessionStateMap | undefined,
  world: Pick<
    SessionReading,
    "canAskPeople" | "earlierRemoteCaller" | "inboxPending" | "now" | "principal"
  >,
): SessionReading {
  const projection = storedProjection(state);
  return {
    ...world,
    recordedRuns: recordedRuns(state),
    tasks: summarizeTasks(readTaskTable(state)),
    turnId: activeTurnId(turnPosition(projection)),
    view: projection.view,
  };
}

/** The tool of each call with one recorded workflow tool run: a call with two counts as neither. */
function recordedRuns(state: SessionStateMap | undefined): Map<string, string> {
  const runs = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { callId, toolName } of getBlockingWorkflowToolRuns(state)) {
    if (runs.has(callId)) ambiguous.add(callId);
    runs.set(callId, toolName);
  }
  for (const callId of ambiguous) runs.delete(callId);
  return runs;
}
