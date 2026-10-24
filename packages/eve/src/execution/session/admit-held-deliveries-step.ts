import { getAdapterKind } from "#channel/adapter.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { ChannelInstrumentationKey, ParentSessionKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { admitDeliveries } from "#execution/session/delivery-facts.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { controlAdmitted } from "#harness/facts.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { ControlDelivery } from "#harness/types.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Records held input without taking it, running delivery hooks, or binding its identity. */
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
        admitDeliveries({
          ...source,
          delivery,
          payloads: delivery.payloads.map((payload) => ({ payload, input: undefined })),
        }).facts.filter((event) => event.type === "delivery.admitted"),
      ),
      ...input.controls.map(({ control, delivery }) => controlAdmitted(delivery, control)),
    ].filter(
      (event) =>
        event.type !== "delivery.admitted" || view.deliveries[event.data.deliveryId] === undefined,
    );
    if (facts.length === 0) return {};
    return await publishSessionEvents(state, facts, { announce: false });
  });
}
