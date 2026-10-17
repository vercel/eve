import { StreamDelivery } from "#client/delivery.js";
import { deliveryEvents } from "#client/delivery-events.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { Runtime, SessionCommandResult } from "#channel/types.js";
import type { Delivery } from "#shared/delivery.js";

/** Turns an accepted internal dispatch into its public, followable receipt. */
export function commandDelivery(
  runtime: Runtime,
  result: SessionCommandResult,
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
    sessionId,
    deliveryId,
    createStream: async function* () {
      yield* deliveryEvents(await runtime.getEventStream(sessionId, options), deliveryId);
    },
  });
}
