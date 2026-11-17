import { sessionView } from "#harness/session-machine/commit.js";
import { programsOf } from "#harness/session-machine/programs.js";
import {
  runtimeWait,
  ownOpenRequestIds,
  type ProgramBatchWait,
} from "#harness/session-machine/view.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import { readTaskTable } from "#execution/tasks/table.js";
import { findBlockingWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { openSignIns } from "#protocol/session-projection/reader.js";

/**
 * What a paused turn waits on, which is one kind of thing at a time. The turn keeps it to resume;
 * the stream reports the pause as `turn.paused`.
 */
export type TurnPause =
  /** Sign-ins whose callbacks resume the turn, and open questions and approvals. */
  | {
      readonly on: "interaction";
      readonly attemptIds: readonly string[];
      readonly requestIds: readonly string[];
    }
  /** Working tasks. Any of them settling resumes the turn. */
  | { readonly on: "tasks"; readonly taskIds: readonly string[] }
  /**
   * Calls whose results resume the turn, task tool calls included. `dispatch` starts their
   * workflow tool runs before the wait; the session answers `taskToolCalls` itself.
   */
  | {
      readonly on: "calls";
      readonly callIds: readonly string[];
      readonly dispatch: boolean;
      readonly taskToolCalls: readonly TaskToolCall[];
      /**
       * The calls programs wait on, one batch each. A batch's results resume its program on
       * their own, and a new message doesn't wait for them or interrupt their runs.
       */
      readonly batches?: readonly ProgramBatchWait[];
      /** The model ended the turn while tasks work: one of them settling also resumes it. */
      readonly heldOnTasks?: true;
    };

/** The turn waits on sign-ins and answers to its interactions. */
export function pausedOnInteraction(
  session: HarnessSession,
  projection: SessionProjection,
): TurnPause {
  const challenges = sessionView(projection, session.state).signIns;
  return {
    attemptIds: challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    on: "interaction",
    requestIds: [...ownOpenRequestIds(sessionView(projection, session.state))],
  };
}

/** The model ended the turn while tasks work, so the turn waits for one of them. */
export function pausedOnTasks(taskIds: readonly string[]): TurnPause {
  return { on: "tasks", taskIds };
}

/**
 * The runs a paused step asked for that no dispatch started yet. A wait can return before every
 * call has a result, when a program's batch settles or a new message arrives, and the calls
 * still running then must not start again in the wait that follows.
 */
export function undispatched<T extends RuntimeWorkflowTaskRequest>(
  state: HarnessSession["state"],
  requests: readonly T[],
): readonly T[] {
  const { tasks } = readTaskTable(state);
  return requests.filter((request) => {
    if (request.entry.entryPoint === "execute") {
      return findBlockingWorkflowToolRun(state, request.callId) === undefined;
    }
    const record = tasks.find((task) => task.calls.some((call) => call.callId === request.callId));
    // A call to a running task joins its record when it is sent; a new task's run is recorded
    // when it starts.
    return request.entry.entryPoint === "receive"
      ? record === undefined
      : record?.run === undefined;
  });
}

/** The turn waits on calls the runtime runs, or on none. */
export function pausedOnCalls(
  session: HarnessSession,
): Extract<TurnPause, { readonly on: "calls" }> | undefined {
  const waiting = runtimeWait(session.state);
  if (waiting === undefined) return undefined;
  return {
    ...(waiting.batches.length > 0 && { batches: waiting.batches }),
    callIds: waiting.callIds,
    dispatch: undispatched(session.state, waiting.tasks).length > 0,
    on: "calls",
    taskToolCalls: waiting.taskToolCalls,
  };
}

/**
 * Whether the turn waits on a sign-in, an answer, a call, or a program that hasn't finished,
 * which ends a batch of model calls: a program's step follows the one that saved it.
 */
export function waitsOnAnything(session: HarnessSession, projection: SessionProjection): boolean {
  const view = sessionView(projection, session.state);
  return (
    openSignIns(projection.view).length > 0 ||
    ownOpenRequestIds(view).size > 0 ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0 ||
    programsOf(view.turn).length > 0
  );
}
