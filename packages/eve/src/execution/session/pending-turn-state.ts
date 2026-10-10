import { readHitlState } from "#harness/hitl/index.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
import { runtimeWait } from "#harness/session-machine/view.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import { type SessionProjection, waitsOnSignIn } from "#protocol/session-projection.js";

/**
 * What a paused turn waits on, which is one kind of thing at a time. The turn keeps it to resume;
 * the stream reports the pause as `turn.waiting`.
 */
export type TurnPause =
  /** Sign-ins whose callbacks resume the turn, and questions and approvals a person answers. */
  | {
      readonly on: "person";
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
    };

/** The turn waits on the sign-ins and the answers it asked a person for. */
export function pausedOnPerson(session: HarnessSession, projection: SessionProjection): TurnPause {
  const challenges = readHitlState(session.state).signIns;
  return {
    attemptIds: challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    on: "person",
    requestIds: [...ownOpenRequestIds(sessionView(projection, session.state))],
  };
}

/** The model ended the turn while tasks work, so the turn waits for one of them. */
export function pausedOnTasks(taskIds: readonly string[]): TurnPause {
  return { on: "tasks", taskIds };
}

/** The turn waits on calls the runtime runs, or on none. */
export function pausedOnCalls(session: HarnessSession): TurnPause | undefined {
  const waiting = runtimeWait(session.state);
  if (waiting === undefined) return undefined;
  return {
    callIds: waiting.callIds,
    dispatch: waiting.tasks.length > 0,
    on: "calls",
    taskToolCalls: waiting.taskToolCalls,
  };
}

/** Whether the turn waits on a sign-in, an answer, or a call, which ends a batch of model calls. */
export function waitsOnAnything(session: HarnessSession, projection: SessionProjection): boolean {
  return (
    waitsOnSignIn(projection.view) ||
    ownOpenRequestIds(sessionView(projection, session.state)).size > 0 ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0
  );
}
