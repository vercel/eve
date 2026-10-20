import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { controlAdmitted } from "#harness/facts.js";
import type { ControlDelivery } from "#harness/types.js";

/** Records controls that finish without cancelling a turn, at an owner's committed boundary. */
export async function settleCancelDeliveryStep(
  input: SessionStepState & {
    readonly control: ControlDelivery;
    readonly outcome: "ignored" | "applied";
  },
) {
  "use step";
  return await withSessionStateDelta(input, (state) =>
    publishSessionEvents(state, [
      controlAdmitted(input.control, "cancel"),
      {
        type: "delivery.settled",
        data: { deliveryId: input.control.deliveryId, outcome: input.outcome },
      },
    ]),
  );
}
