import type { DeliverHookPayload } from "#channel/types.js";

// Read by the session owner between steps, so it imports nothing a workflow body can't load.

export const REACTIONS_STATE_KEY = "eve.reactions";

/**
 * A hook's `ctx.followUp()`: the delivery that starts the session's next turn, for the turn that
 * settled. Any other turn that starts first discards it, as do a cancel and a reset.
 */
export interface FollowUpIntent {
  readonly reactionId: string;
  readonly occurrence: string;
  readonly type: "follow-up";
  /** The settled turn it follows up. */
  readonly turnId: string;
  readonly delivery: DeliverHookPayload;
}

/** Whether `intents` already hold a follow-up to `turnId`. */
export function followsUp(
  intents: readonly { readonly type: string }[] | undefined,
  turnId: string,
): boolean {
  return (intents ?? []).some(
    (intent) => intent.type === "follow-up" && (intent as FollowUpIntent).turnId === turnId,
  );
}

/**
 * The follow-up a hook queued after `latestTurnId` settled, while no other turn has started since.
 * The session admits it only when nothing else waits.
 */
export function pendingFollowUp(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): DeliverHookPayload | undefined {
  if (latestTurnId === undefined) return undefined;
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly intents?: readonly { readonly type: string }[] }
    | undefined;
  const followUp = state?.intents?.find(
    (intent): intent is FollowUpIntent =>
      intent.type === "follow-up" && (intent as FollowUpIntent).turnId === latestTurnId,
  );
  return followUp?.delivery;
}
