import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { CancelTurnInput, CancelTurnResult } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { getWorld, reenqueueRun, resumeHook } from "#internal/workflow/runtime.js";
import {
  sessionCancelHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";

const log = createLogger("execution.turn-cancellation-request");

/** Requests cancellation through a session's stable workflow hook. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  const payload: TurnCancelPayload = input.turnId === undefined ? {} : { turnId: input.turnId };

  try {
    await resumeHook(sessionCancelHookToken(input.sessionId), payload);
  } catch (error) {
    const reason = classifyInactiveCancelTarget(error);
    if (reason !== undefined) {
      return { reason, status: "no_active_turn" };
    }
    throw error;
  }

  // The world does not reliably reschedule a suspended run when one of its
  // hooks is resumed: a parked parent has been observed holding an accepted
  // cancel for minutes without a single execution. Nudge the scheduler
  // explicitly. The resume payload above is already durable, so a failed
  // nudge only re-exposes that wake race — never a lost cancel — and a
  // redundant one is a harmless replay.
  try {
    await reenqueueRun(await getWorld(), input.sessionId);
  } catch (error) {
    logError(log, "failed to re-enqueue the cancelled session's run", error, {
      sessionId: input.sessionId,
    });
  }

  return { status: "accepted" };
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
