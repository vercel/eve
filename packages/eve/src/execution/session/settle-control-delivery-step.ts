import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { controlSettled, type ControlSettlement } from "#harness/facts.js";

/** Records a control that finishes without a step of its own, at an owner's committed boundary. */
export async function settleControlDeliveryStep(
  input: SessionStepState & { readonly settlement: ControlSettlement },
) {
  "use step";
  return await withSessionStateDelta(input, (state) =>
    publishSessionEvents(state, controlSettled(input.settlement)),
  );
}
