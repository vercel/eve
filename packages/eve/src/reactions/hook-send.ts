import type { DeliverHookPayload } from "#channel/types.js";

// Read by the session owner between steps, so it imports nothing a workflow body can't load.

export const REACTIONS_STATE_KEY = "eve.reactions";

/**
 * A hook's `ctx.send()`: the delivery that starts the session's next turn, for the turn that
 * settled. Any other turn that starts first discards it, as do a cancel and a reset.
 */
export interface HookSendIntent {
  readonly reactionId: string;
  readonly occurrence: string;
  readonly type: "send";
  /** The settled turn it continues. */
  readonly turnId: string;
  readonly delivery: DeliverHookPayload;
}

/**
 * The delivery a hook sent after `latestTurnId` settled, while no other turn has started since.
 * The session admits it only when nothing else waits.
 */
export function pendingHookSend(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): DeliverHookPayload | undefined {
  if (latestTurnId === undefined) return undefined;
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly intents?: readonly { readonly type: string }[] }
    | undefined;
  const send = state?.intents?.find(
    (intent): intent is HookSendIntent =>
      intent.type === "send" && (intent as HookSendIntent).turnId === latestTurnId,
  );
  return send?.delivery;
}
