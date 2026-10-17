import { getAdapterKind } from "#channel/adapter.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { ChannelInstrumentationKey, ParentSessionKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { admissionOf } from "#execution/session/delivery-facts.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { controlAdmitted } from "#harness/facts.js";
import type { ControlDelivery } from "#harness/types.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/**
 * Admits the deliveries the session holds before it waits, so that while it waits, its stream
 * shows every delivery it has: a message queued behind the turn, an answer to nothing yet, or a
 * control that runs once the turn ends. What later takes one admits it again, which the writer
 * drops (`cascade`).
 */
export async function admitHeldDeliveriesStep(
  input: SessionStepState & {
    readonly deliveries: readonly DeliverHookPayload[];
    readonly controls: readonly { readonly control: string; readonly delivery: ControlDelivery }[];
  },
) {
  "use step";
  return await withSessionStateDelta(input, async (state) => {
    const ctx = await deserializeContext(state.serializedContext);
    const view = storedProjection(readDurableSession(state.sessionState).state).view;
    const source = {
      channelKind:
        ctx.get(ChannelInstrumentationKey)?.kind ?? getAdapterKind(ctx.require(ChannelKey)),
      parent: ctx.get(ParentSessionKey),
      sessionStarted: true,
    };
    const facts = [
      ...input.deliveries.flatMap((delivery) =>
        delivery.payloads.map((payload) => admissionOf({ ...source, delivery, payload }).fact),
      ),
      ...input.controls.map(({ control, delivery }) => controlAdmitted(delivery, control)),
    ].filter(
      (fact) =>
        fact.type !== "delivery.admitted" || view.deliveries[fact.data.deliveryId] === undefined,
    );
    if (facts.length === 0) return {};
    return await publishSessionEvents(state, facts);
  });
}
