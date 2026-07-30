import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { CancelTurnInput, CancelTurnResult } from "#channel/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import {
  sessionCancelHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";

/** Requests cancellation through a session's stable workflow hook. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  const payload: TurnCancelPayload = input.turnId === undefined ? {} : { turnId: input.turnId };

  try {
    await resumeHook(sessionCancelHookToken(input.sessionId), payload);
    return { status: "accepted" };
  } catch (error) {
    const reason = classifyInactiveCancelTarget(error);
    if (reason !== undefined) {
      return { reason, status: "no_active_turn" };
    }
    throw error;
  }
}

/**
 * Returns true when a `no_active_turn` reason can heal with time — world
 * contention such as a hook-claim conflict during a queue wake. Terminal
 * reasons (hook gone, run gone, run expired) mean the target turn already
 * settled and will never accept a cancel again.
 */
export function isRetryableInactiveCancelReason(reason: string | undefined): boolean {
  return reason === "EntityConflictError";
}

function classifyInactiveCancelTarget(error: unknown): string | undefined {
  if (HookNotFoundError.is(error)) return "HookNotFoundError";
  if (WorkflowRunNotFoundError.is(error)) return "WorkflowRunNotFoundError";
  if (RunExpiredError.is(error)) return "RunExpiredError";
  if (EntityConflictError.is(error)) return "EntityConflictError";
  return undefined;
}
