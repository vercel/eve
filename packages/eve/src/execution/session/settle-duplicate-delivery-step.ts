import type { DeliverHookPayload } from "#channel/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { admitDeliveries } from "#execution/session/delivery-facts.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { storedProjection } from "#harness/session-machine/view.js";

/** A duplicate starts no work, but its distinct receipt must still settle. */
export async function settleDuplicateDeliveryStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
) {
  "use step";
  return await withSessionStateDelta(input, (state) => {
    const view = storedProjection(readDurableSession(state.sessionState).state).view;
    const { facts } = admitDeliveries({
      channelKind: "http",
      delivery: input.delivery,
      payloads: input.delivery.payloads.flatMap((payload, index) => {
        const metadata = input.delivery.deliveryMetadata?.find(
          (entry) => entry.payloadIndex === index,
        );
        // Reforwarding the very same receipt must not retire its original work.
        return metadata !== undefined && view.deliveries[metadata.deliveryId] !== undefined
          ? []
          : [{ payload, input: undefined }];
      }),
    });
    return publishSessionEvents(
      state,
      facts.map((event) =>
        event.type === "delivery.settled"
          ? { ...event, data: { ...event.data, reason: "duplicate idempotency key" } }
          : event,
      ),
    );
  });
}
