import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds, runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { hasQueuedTurnInput } from "#harness/step/park.js";
import { readTaskTable, tasksWithResults, workingTasks } from "#execution/tasks/table.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import {
  activeTurn,
  hasUnweighedAnswers,
  openWork,
} from "#protocol/session-projection/selectors.js";
import type { StepState } from "./step-decision.js";

/** Samples the fold, private continuations, and the step's reported progress. */
export function readStepState(
  session: Pick<HarnessSession, "state">,
  unreadInput?: StepResult["unreadInput"],
): StepState {
  const projection = storedProjection(session.state);
  const tables = projection.view;
  const machine = sessionView(projection, session.state);
  const turnId = activeTurn(tables)?.turnId;
  const tasks = readTaskTable(session.state);
  const calls = runtimeWait(session.state);
  return {
    ended: tables.session.status === "ended",
    queuedInput: hasQueuedTurnInput(machine),
    requestIds: [...ownOpenRequestIds(machine)],
    signIns: machine.signIns,
    turnOpen: turnId !== undefined,
    unreadInput: unreadInput === true || tasksWithResults(tasks).length > 0,
    unweighedAnswers:
      turnId !== undefined && hasUnweighedAnswers(tables, openWork(tables, { turnId })),
    workingTaskIds: workingTasks(tasks).map((record) => record.id),
    ...(calls !== undefined && {
      calls: {
        callIds: calls.callIds,
        // Runs dispatch once; a call whose run already started needs none.
        dispatch: calls.tasks.some((task) => {
          const status = tables.calls[task.callId]?.status;
          return status === undefined || status === "requested";
        }),
        taskToolCalls: calls.taskToolCalls,
      },
    }),
  };
}
