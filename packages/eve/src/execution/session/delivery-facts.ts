import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { ConsumedDelivery } from "#harness/session-machine/transitions.js";
import type { HarnessStepInput, StepInput } from "#harness/types.js";
import { userPartsOf } from "#harness/user-parts.js";
import { readClientContext } from "#internal/client-context.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { JsonValue, Principal } from "#protocol/session-events/envelope.js";
import type { DeliverySource } from "#protocol/session-events/families/delivery.js";

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
  /** Whether the session already admitted a delivery, as when it forwarded part of it. */
  readonly admitted?: (deliveryId: string) => boolean;
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
    const source: {
      -readonly [K in keyof Extract<DeliverySource, { channel: string }>]: Extract<
        DeliverySource,
        { channel: string }
      >[K];
    } = {
      channel: metadata?.channelKind ?? input.channelKind,
    };
    if (delivery.schedule?.definition !== undefined)
      source.scheduleId = delivery.schedule.definition;
    const data: {
      deliveryId: string;
      principal?: Principal;
      source: DeliverySource;
      clientContext?: JsonValue;
    } = {
      deliveryId,
      source,
    };
    if (principal !== undefined) data.principal = principal;
    const clientContext = readClientContext(payload);
    if (clientContext !== undefined && clientContext.length > 0)
      data.clientContext = [...clientContext];
    if (input.admitted?.(deliveryId) !== true) facts.push({ data, type: "delivery.admitted" });
    if (stepInput === undefined) {
      facts.push({ data: { deliveryId, outcome: "ignored" }, type: "delivery.settled" });
      continue;
    }
    const consumed: ConsumedDelivery = {
      deliveryId,
      parts: stepInput.message === undefined ? [] : userPartsOf(stepInput.message),
    };
    const { answers, ...rest } = stepInput;
    inputs.push(
      answers === undefined || answers.length === 0
        ? { ...rest, deliveries: [consumed] }
        : {
            ...rest,
            answers: answers.map((answer, index) => ({
              ...answer,
              deliveryId,
              responseId: `response_${deliveryId}_${String(index)}`,
            })),
            deliveries: [consumed],
          },
    );
  }
  return { facts, inputs };
}

/** Who sent a delivery, as the wire names them. */
export function principalOf(auth: SessionAuthContext | null | undefined): Principal | undefined {
  if (auth === undefined || auth === null) return undefined;
  const principal: { -readonly [K in keyof Principal]: Principal[K] } = {
    id: auth.principalId,
    type: auth.principalType,
  };
  if (auth.issuer !== undefined) principal.issuer = auth.issuer;
  return principal;
}
