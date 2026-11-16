import { publishSessionEvents, type SessionStepInput } from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { ControlSettlement } from "#harness/facts.js";
import { settleControl } from "#harness/session-machine/deliveries.js";

/** Records a control that finishes without a step of its own, at an owner's committed boundary. */
export async function settleControlDeliveryStep(
  input: SessionStepInput & { readonly settlement: ControlSettlement },
) {
  "use step";
  return await withSessionStateDelta(input, (state) =>
    publishSessionEvents(state, [settleControl(input.settlement)]),
  );
}
