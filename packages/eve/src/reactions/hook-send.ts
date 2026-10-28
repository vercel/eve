import type { DeliverHookPayload } from "#channel/types.js";

// Read by the session owner between steps, so it imports nothing a workflow body can't load.

export const REACTIONS_STATE_KEY = "eve.reactions";

/**
 * The session's follow-up to a turn: one delivery that starts the session's next turn once that
 * turn settles, with a payload for each hook that sent with `turnPolicy: "yield"`. Any other turn
 * that starts first discards it, as do a cancel, a clear, and a reset.
 */
export interface FollowUp {
  /** The turn it follows up; absent before the session's first turn. */
  readonly turnId?: string;
  readonly delivery: DeliverHookPayload;
}

/** The idempotency key of a turn's follow-up: one delivery per turn. */
export function followUpKey(sessionId: string, turnId: string | undefined): string {
  return `${sessionId}:follow-up:${turnId ?? "start"}`;
}

interface StoredSends {
  readonly followUp?: FollowUp;
  readonly sends?: readonly DeliverHookPayload[];
}

function storedSends(serializedContext: Readonly<Record<string, unknown>>): StoredSends {
  return (serializedContext[REACTIONS_STATE_KEY] as StoredSends | undefined) ?? {};
}

/**
 * The follow-up hooks queued for `latestTurnId`, while no other turn has started since. The session
 * admits it only when nothing else waits.
 */
export function pendingFollowUp(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): DeliverHookPayload | undefined {
  const { followUp } = storedSends(serializedContext);
  return followUp !== undefined && followUp.turnId === latestTurnId ? followUp.delivery : undefined;
}

/**
 * Messages hooks sent with `turnPolicy: "steer"` or `"queue"` that the session hasn't admitted yet,
 * in the order they were sent. The session admits them like a person's messages; each one's
 * idempotency key keeps it from being admitted twice.
 */
export function pendingHookSends(
  serializedContext: Readonly<Record<string, unknown>>,
): readonly DeliverHookPayload[] {
  return storedSends(serializedContext).sends ?? [];
}
