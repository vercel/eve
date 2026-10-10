import { readHitlState } from "#harness/hitl/index.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
import { runtimeWait } from "#harness/session-machine/view.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import { openSignIns, type SessionProjection } from "#protocol/session-projection.js";

/**
 * Derives the workflow fields used to select the next action at the park boundary. Whether the
 * session awaits input or a sign-in is the projection's; which callbacks resume it, and which
 * calls wait on the runtime, is execution state.
 */
export function derivePendingState(
  session: HarnessSession,
  projection: SessionProjection,
): {
  readonly authorizationAttemptIds?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  /** The pending batch has workflow tool runs to start; task tool calls are answered by the session. */
  readonly hasRunsToDispatch?: boolean;
  readonly pendingCoordinationCallIds?: readonly string[];
  readonly pendingTaskToolCalls?: readonly TaskToolCall[];
} {
  const { signIns } = readHitlState(session.state);
  const base = {
    authorizationAttemptIds:
      signIns.length === 0
        ? undefined
        : signIns.flatMap((challenge) =>
            challenge.attemptId === undefined ? [] : [challenge.attemptId],
          ),
    hasPendingAuthorization: openSignIns(projection).length > 0,
    hasPendingInputBatch: ownOpenRequestIds(sessionView(projection, session.state)).size > 0,
  };
  const waiting = runtimeWait(session.state);
  if (waiting === undefined) return base;
  return {
    ...base,
    hasRunsToDispatch: waiting.tasks.length > 0,
    pendingCoordinationCallIds: waiting.callIds,
    pendingTaskToolCalls: waiting.taskToolCalls,
  };
}
