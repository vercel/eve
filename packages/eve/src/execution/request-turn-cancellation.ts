import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import {
  sessionCancelHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Outcome of a turn-cancellation request.
 *
 * - `"cancelling"`: the cancel was delivered to a live turn. Delivery is
 *   not settlement — callers observe `turn.cancelled` followed by
 *   `session.waiting` on the session stream. A stale `turnId` guard is
 *   also reported as `"cancelling"`: the payload was delivered and is
 *   consumed inside the turn as a benign no-op.
 * - `"no_active_turn"`: nothing to cancel — no turn in flight, the turn
 *   already settled, a duplicate cancel, or an uncancellable turn
 *   (task-mode sessions and hook-conflict-degraded turns register no
 *   cancel hook).
 */
export type TurnCancellationRequestStatus = "cancelling" | "no_active_turn";

/**
 * Requests cancellation of a session's in-flight turn by resuming the
 * stable `{sessionId}:cancel` hook claimed by the running turn workflow.
 * Both outcomes are success; duplicate and late requests are benign.
 * Rejections other than "no live hook" indicate a runtime fault and are
 * rethrown.
 */
export async function requestTurnCancellation(input: {
  readonly sessionId: string;
  readonly turnId?: string;
}): Promise<TurnCancellationRequestStatus> {
  const payload: TurnCancelPayload = input.turnId === undefined ? {} : { turnId: input.turnId };

  try {
    await resumeHook(sessionCancelHookToken(input.sessionId), payload);
    return "cancelling";
  } catch (error) {
    if (HookNotFoundError.is(error)) {
      return "no_active_turn";
    }
    throw error;
  }
}
