import { getPendingAuthorization } from "#harness/authorization.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
import { runtimeWait } from "#harness/session-machine/view.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import { openSignIns, type SessionProjection } from "#protocol/session-projection.js";

/** What a paused turn waits on, as the event lifecycle's `turn.paused.awaiting` lists it. */
export interface TurnAwaiting {
  /** Sign-ins whose callbacks resume the turn. */
  readonly attemptIds: readonly string[];
  /** Questions and approvals a person answers. */
  readonly requestIds: readonly string[];
  /** Calls whose results resume the turn, task tool calls included. */
  readonly callIds: readonly string[];
  /** Working tasks. Any of them settling resumes the turn. */
  readonly taskIds: readonly string[];
}

/** A paused turn: what it waits on, and the calls the session starts or answers for it. */
export interface TurnPause {
  readonly awaiting: TurnAwaiting;
  /** Workflow tool runs to start before waiting. Task tool calls need none. */
  readonly dispatch: boolean;
  /** Task tool calls the session answers itself. */
  readonly taskToolCalls: readonly TaskToolCall[];
}

const NOTHING: TurnAwaiting = { attemptIds: [], callIds: [], requestIds: [], taskIds: [] };

/** The turn waits on the sign-ins and the answers it asked a person for. */
export function pausedOnPerson(session: HarnessSession, projection: SessionProjection): TurnPause {
  const challenges = getPendingAuthorization(session.state)?.challenges ?? [];
  return {
    awaiting: {
      ...NOTHING,
      attemptIds: challenges.flatMap((challenge) =>
        challenge.attemptId === undefined ? [] : [challenge.attemptId],
      ),
      requestIds: [...ownOpenRequestIds(sessionView(projection, session.state))],
    },
    dispatch: false,
    taskToolCalls: [],
  };
}

/** The model ended the turn while tasks work, so the turn waits for one of them. */
export function pausedOnTasks(taskIds: readonly string[]): TurnPause {
  return { awaiting: { ...NOTHING, taskIds }, dispatch: false, taskToolCalls: [] };
}

/** The turn waits on calls the runtime runs, or on none. */
export function pausedOnCalls(session: HarnessSession): TurnPause | undefined {
  const waiting = runtimeWait(session.state);
  if (waiting === undefined) return undefined;
  return {
    awaiting: { ...NOTHING, callIds: waiting.callIds },
    dispatch: waiting.tasks.length > 0,
    taskToolCalls: waiting.taskToolCalls,
  };
}

/** Whether the turn waits on a sign-in, an answer, or a call, which ends a batch of model calls. */
export function waitsOnAnything(session: HarnessSession, projection: SessionProjection): boolean {
  return (
    openSignIns(projection).length > 0 ||
    ownOpenRequestIds(sessionView(projection, session.state)).size > 0 ||
    (runtimeWait(session.state)?.callIds.length ?? 0) > 0
  );
}
