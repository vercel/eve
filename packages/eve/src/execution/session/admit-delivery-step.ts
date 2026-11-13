import type { DeliverHookPayload } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepInput } from "#execution/publish-session-events.js";
import { planAdmission } from "#execution/session/delivery-facts.js";
import type { AdmitAction } from "#execution/session/input-queue.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { decideAdmission } from "#harness/stack/kernel.js";
import { admitDeliveries } from "#harness/session-machine/deliveries.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { userPartsOf } from "#harness/user-parts.js";

// What a message that arrives during a turn does, as the session's harness's `admit` decides.
// The loop asks only when the session's harness has the stage. eve's own rule is below every
// layer, and a harness can only narrow it: a message eve keeps out of the turn stays out. A
// dropped message settles `ignored` with the harness's reason, so its sender learns why.

export async function admitDeliveryStep(
  input: SessionStepInput & {
    readonly delivery: DeliverHookPayload;
    /** eve's own answer: whether the message would join the running turn. */
    readonly joins: boolean;
  },
) {
  "use step";
  return await withSessionStateDelta(input, async (state) => {
    const ctx = await deserializeContext(state.serializedContext);
    const view = storedProjection(readDurableSession(state.sessionState).state).view;
    const { delivery } = input;
    const eve: AdmitAction = input.joins ? "join" : "queue";
    const decided = await decideAdmission(ctx, {
      delivery: {
        from: delivery.auth === undefined ? (ctx.get(AuthKey) ?? null) : delivery.auth,
        text: delivery.payloads
          .flatMap((payload) =>
            payload.message === undefined
              ? []
              : userPartsOf(payload.message).flatMap((part) =>
                  part.kind === "text" ? [part.text] : [],
                ),
          )
          .join("\n"),
      },
      eve,
      view,
    });
    // A harness can't let in a message eve keeps out of the turn.
    const action: AdmitAction = decided.action === "join" && eve !== "join" ? eve : decided.action;
    if (action !== "drop") return { action, sessionState: state.sessionState };
    const { deliveries } = planAdmission({
      channelKind: "http",
      delivery,
      payloads: delivery.payloads.flatMap((payload) => {
        const metadata = delivery.deliveryMetadata?.find(
          (entry) => entry.payloadIndex === delivery.payloads.indexOf(payload),
        );
        return metadata !== undefined && view.deliveries[metadata.deliveryId] !== undefined
          ? []
          : [{ input: undefined, payload }];
      }),
    });
    const reason = decided.reason ?? "the agent's harness dropped it";
    return {
      action,
      ...(await publishSessionEvents(state, [
        admitDeliveries(deliveries.map((entry) => ({ ...entry, ignored: { reason } }))),
      ])),
    };
  });
}
