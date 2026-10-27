import type { DeliverHookPayload } from "#channel/types.js";

// Read by the session owner between steps, so it imports nothing a workflow body can't load.

export const REACTIONS_STATE_KEY = "eve.reactions";

/**
 * The session's follow-up to a settled turn: one delivery that starts its next turn, with a payload
 * for each hook that called `ctx.followUp()`. Any other turn that starts first discards it, as do a
 * cancel, a clear, and a reset.
 */
export interface FollowUp {
  /** The settled turn it follows up. */
  readonly turnId: string;
  readonly delivery: DeliverHookPayload;
}

/** The idempotency key of a turn's follow-up: one delivery per settled turn. */
export function followUpKey(sessionId: string, turnId: string): string {
  return `${sessionId}:follow-up:${turnId}`;
}

/**
 * The follow-up hooks queued after `latestTurnId` settled, while no other turn has started since.
 * The session admits it only when nothing else waits.
 */
export function pendingFollowUp(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): DeliverHookPayload | undefined {
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly followUp?: FollowUp }
    | undefined;
  return latestTurnId !== undefined && state?.followUp?.turnId === latestTurnId
    ? state.followUp.delivery
    : undefined;
}
