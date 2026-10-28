import type { DeliverHookPayload } from "#channel/types.js";
import { ANONYMOUS_PRINCIPAL, principalOf } from "#execution/session/principal.js";

// Read by the session owner between steps, so it imports nothing a workflow body can't load.

export const REACTIONS_STATE_KEY = "eve.reactions";

/** A message a hook sent with `ctx.send()` that the session hasn't admitted yet. */
export interface PendingSend {
  readonly delivery: DeliverHookPayload;
  /**
   * Set for a yielding message: the turn it waits on, the session's latest when the hook sent it,
   * or none before the first turn. Once another turn starts, the message is dropped. `opening`
   * marks one sent while a delivery opens a turn, which waits on that turn once it starts.
   */
  readonly preemptible?: { readonly turnId: string | undefined; readonly opening?: true };
}

function storedSends(serializedContext: Readonly<Record<string, unknown>>): readonly PendingSend[] {
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly sends?: readonly PendingSend[] }
    | undefined;
  return state?.sends ?? [];
}

/**
 * The messages hooks sent that the session admits like a person's, in the order they were sent.
 * Each one's idempotency key keeps it from being admitted twice.
 */
export function pendingHookSends(
  serializedContext: Readonly<Record<string, unknown>>,
): readonly DeliverHookPayload[] {
  return storedSends(serializedContext).flatMap(({ delivery, preemptible }) =>
    preemptible === undefined ? [delivery] : [],
  );
}

/**
 * The yielding messages that start the session's next turn once nothing else waits: the first one
 * sent since `latestTurnId` started, and those after it that the queue puts in the same turn, for
 * the same principal. Any other would start a turn after it, so it waits, and is dropped once the
 * turn starts. The queue gives each anonymous message its own turn, so only the first goes.
 */
export function pendingPreemptibleSends(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): readonly DeliverHookPayload[] {
  const waiting = storedSends(serializedContext).flatMap(({ delivery, preemptible }) =>
    preemptible !== undefined && preemptible.turnId === latestTurnId ? [delivery] : [],
  );
  const [first] = waiting;
  if (first === undefined) return [];
  const principal = principalOf(first.auth);
  if (principal === ANONYMOUS_PRINCIPAL) return [first];
  return waiting.filter(({ auth }) => principalOf(auth) === principal);
}
