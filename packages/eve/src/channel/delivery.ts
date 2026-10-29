import { StreamDelivery } from "#client/delivery.js";
import { deliveryEvents } from "#client/delivery-events.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { Runtime, SessionCommand, SessionCommandResult } from "#channel/types.js";
import type { Delivery } from "#shared/delivery.js";

/** Turns an accepted internal dispatch into its public, followable receipt. */
export function commandDelivery(
  runtime: Runtime,
  result: SessionCommandResult<Exclude<SessionCommand, { readonly kind: "prewarm" }>>,
  deliveryId: string,
  options: { readonly follow?: boolean } = {},
): Delivery {
  if (result.status !== "accepted" && result.status !== "reset") {
    throw new SessionNotActiveError({
      retryable: "retryable" in result && result.retryable === true,
    });
  }
  const sessionId = result.status === "reset" ? result.previousSessionId : result.sessionId;
  return new StreamDelivery({
    inbox: "inbox" in result ? result.inbox : undefined,
    sessionId,
    deliveryId,
    createStream: async function* (read) {
      yield* deliveryEvents(
        await runtime.getEventStream(sessionId, { ...options, signal: read?.signal }),
        deliveryId,
        read?.signal,
      );
    },
  });
}
