import { readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { admitDeliveries } from "#execution/session/delivery-facts.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { droppedHookSends } from "#reactions/hook-send.js";

/**
 * Records the hooks' messages the session dropped, so every `deliveryId` `ctx.send()` returned
 * ends in a `delivery.settled`: admitted, then settled `ignored` with why it was dropped, as a
 * duplicate delivery is. With `reset`, every message still waiting is recorded as reset.
 */
export async function settleDroppedHookSendsStep(
  input: SessionStepState & { readonly reset?: boolean },
) {
  "use step";
  return await withSessionStateDelta(input, (state) => {
    const view = storedProjection(readDurableSession(state.sessionState).state).view;
    const facts = droppedHookSends(state.serializedContext, { reset: input.reset }).flatMap(
      ({ delivery, reason }) =>
        admitDeliveries({
          channelKind: delivery.deliveryMetadata?.[0]?.channelKind ?? "http",
          delivery,
          payloads: delivery.payloads.flatMap((payload, index) => {
            const metadata = delivery.deliveryMetadata?.find(
              (entry) => entry.payloadIndex === index,
            );
            // A retried step already recorded it.
            return metadata !== undefined && view.deliveries[metadata.deliveryId] !== undefined
              ? []
              : [{ payload, input: undefined }];
          }),
        }).facts.map((event) =>
          event.type === "delivery.settled" ? { ...event, data: { ...event.data, reason } } : event,
        ),
    );
    return publishSessionEvents(state, facts);
  });
}
