import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { ConsumedDelivery } from "#harness/session-machine/transitions.js";
import type { HarnessStepInput, StepInput } from "#harness/types.js";
import { defined, fact } from "#harness/facts.js";
import { userPartsOf } from "#harness/user-parts.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Principal } from "#protocol/session-events/envelope.js";
import type { DeliverySource } from "#protocol/session-events/families/delivery.js";
import type { DeliveryRow } from "#protocol/session-projection/tables.js";

// A delivery's facts at the step that admits it: every payload is admitted, a payload the
// channel's `deliver` hook ignored settles `ignored` at once, and the rest go on to the turn,
// which consumes them. Deliveries are admitted at step boundaries, since only steps write.

/**
 * What one step admits: the facts it writes first, and each consumed payload's input, carrying
 * its delivery and each answer bound to the response it submits.
 */
export interface DeliveryAdmission {
  readonly facts: readonly SessionEvent[];
  readonly inputs: readonly HarnessStepInput[];
}

export function admitDeliveries(input: {
  /** The delivery as the session accepted it. */
  readonly delivery: DeliverHookPayload;
  /** The payloads left once sign-in callbacks were matched out, with what `deliver` made of each. */
  readonly payloads: readonly {
    readonly payload: DeliverPayload;
    readonly input: StepInput | undefined;
  }[];
  /** The delivery's recorded status, including facts an interrupted attempt already wrote. */
  readonly status?: (deliveryId: string) => DeliveryRow["status"] | undefined;
  readonly channelKind: string;
}): DeliveryAdmission {
  const { delivery } = input;
  const facts: SessionEvent[] = [];
  const inputs: HarnessStepInput[] = [];
  const principal = principalOf(delivery.auth);
  for (const { input: stepInput, payload } of input.payloads) {
    const index = delivery.payloads.indexOf(payload);
    const metadata = delivery.deliveryMetadata?.find((entry) => entry.payloadIndex === index);
    if (metadata === undefined)
      throw new Error(
        "Session delivery has no identity. Assign delivery metadata at dispatch before admission.",
      );
    const deliveryId = metadata.deliveryId;
    const source: DeliverySource = defined({
      channel: metadata.channelKind ?? input.channelKind,
      scheduleId: delivery.schedule?.definition,
    });
    // Turn context stays out of facts: stream readers may see it, and the turn reads it from
    // the payload and its private state instead.
    const status = input.status?.(deliveryId);
    if (status === undefined) {
      facts.push(fact("delivery.admitted", { deliveryId, principal, source }));
    }
    if (stepInput === undefined) {
      if (status !== "settled")
        facts.push(fact("delivery.settled", { deliveryId, outcome: "ignored" }));
      continue;
    }
    const consumed: ConsumedDelivery = defined({
      deliveryId,
      history: (stepInput.history?.length ?? 0) > 0 ? stepInput.history : undefined,
      parts: stepInput.message === undefined ? [] : userPartsOf(stepInput.message),
    });
    const { answers, ...rest } = stepInput;
    inputs.push(
      answers === undefined || answers.length === 0
        ? { ...rest, deliveries: [consumed] }
        : {
            ...rest,
            answers: answers.map((answer, index) =>
              defined({
                interactionId: answer.interactionId,
                optionId: answer.optionId,
                text: answer.text,
                deliveryId,
                responseId: `response_${deliveryId}_${String(index)}`,
              }),
            ),
            deliveries: [consumed],
          },
    );
  }
  return { facts, inputs };
}

/** Who sent a delivery, as the wire names them. */
export function principalOf(auth: SessionAuthContext | null | undefined): Principal | undefined {
  if (auth === undefined || auth === null) return undefined;
  return defined({ id: auth.principalId, issuer: auth.issuer, type: auth.principalType });
}
