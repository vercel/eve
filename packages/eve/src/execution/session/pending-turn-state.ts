import { sessionView } from "#harness/session-machine/commit.js";
import {
  ownOpenRequestIds,
  runtimeWait,
  storedProjection,
  type SessionView,
} from "#harness/session-machine/view.js";
import { holdsMessages, taskWaits } from "#harness/step/park.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { openSignIns } from "#protocol/session-projection/reader.js";

/**
 * What a paused turn waits on, which is one kind of thing at a time. The turn keeps it to resume;
 * the stream reports the pause as `turn.paused`. Calls that wait on a person as tasks never hold
 * the turn, but a person's action on one wakes it however it waits (`TaskWake`).
 */
export type TurnPause =
  /** Sign-ins whose callbacks resume the turn, and open questions and approvals. */
  | ({
      readonly on: "interaction";
      readonly attemptIds: readonly string[];
      readonly requestIds: readonly string[];
      /** An open request takes its answer before any message, such as the budget prompt. */
      readonly answerFirst?: true;
    } & TaskWake)
  /** Working tasks. Any of them settling resumes the turn. */
  | ({ readonly on: "tasks"; readonly taskIds: readonly string[] } & TaskWake)
  /**
   * Calls whose results resume the turn, task tool calls included. `dispatch` starts their
   * workflow tool runs before the wait; the session answers `taskToolCalls` itself.
   */
  | ({
      readonly on: "calls";
      readonly callIds: readonly string[];
      readonly dispatch: boolean;
      readonly taskToolCalls: readonly TaskToolCall[];
    } & TaskWake);

/**
 * What wakes a paused turn for calls that wait on a person as tasks: an answer to one of their
 * requests, or a sign-in callback one of them stopped on, each on its own.
 */
export interface TaskWake {
  readonly taskRequestIds?: readonly string[];
  readonly taskAttemptIds?: readonly string[];
}

/** The turn waits on sign-ins and answers to its interactions. */
export function pausedOnInteraction(
  session: HarnessSession,
  projection: SessionProjection,
): TurnPause {
  const view = sessionView(projection, session.state);
  const wake = taskWake(view);
  const waiting = new Set(wake.taskAttemptIds);
  return {
    attemptIds: view.signIns.flatMap((challenge) =>
      challenge.attemptId === undefined || waiting.has(challenge.attemptId)
        ? []
        : [challenge.attemptId],
    ),
    on: "interaction",
    requestIds: [...ownOpenRequestIds(view)],
    ...(holdsMessages(view) && { answerFirst: true as const }),
    ...wake,
  };
}

/** The model ended the turn while tasks work, so the turn waits for one of them. */
export function pausedOnTasks(
  session: HarnessSession,
  projection: SessionProjection,
  taskIds: readonly string[],
): TurnPause {
  return { on: "tasks", taskIds, ...taskWake(sessionView(projection, session.state)) };
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
    ...taskWake(sessionView(storedProjection(session.state), session.state)),
  };
}

function taskWake(view: SessionView): TaskWake {
  const { requestIds, signIns } = taskWaits(view);
  const taskAttemptIds = signIns.flatMap((challenge) =>
    challenge.attemptId === undefined ? [] : [challenge.attemptId],
  );
  return requestIds.size === 0 && taskAttemptIds.length === 0
    ? {}
    : { taskAttemptIds, taskRequestIds: [...requestIds] };
}

/**
 * Whether the turn waits on a sign-in, an answer, or a call, which ends a batch of model calls.
 * What a call that waits as a task waits on doesn't hold the turn.
 */
export function waitsOnAnything(session: HarnessSession, projection: SessionProjection): boolean {
  const view = sessionView(projection, session.state);
  const { requestIds } = taskWaits(view);
  return (
    openSignIns(projection.view).some((row) => !requestIds.has(row.interactionId)) ||
    [...ownOpenRequestIds(view)].some((interactionId) => !requestIds.has(interactionId)) ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0
  );
}
