import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { ConsumedDelivery } from "#harness/session-machine/transitions.js";
import type { StepInput } from "#harness/types.js";
import { userPartsOf } from "#harness/user-parts.js";
import { readClientContext } from "#internal/client-context.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { JsonValue, Principal } from "#protocol/session-events/envelope.js";
import type { DeliverySource } from "#protocol/session-events/families/delivery.js";
import type {
  ResponseSubmittedData,
  ResponseValue,
} from "#protocol/session-events/families/response.js";

// A delivery's facts at the step that admits it: every payload is admitted, a payload the
// channel's `deliver` hook ignored settles `ignored` at once, and the rest go on to the turn,
// which consumes them. Deliveries are admitted at step boundaries, since only steps write.

/** What one step admits: the facts it writes first, and the deliveries its turn consumes. */
export interface DeliveryAdmission {
  readonly facts: readonly SessionEvent[];
  readonly consumed: readonly ConsumedDelivery[];
  /** The identities of answers, before coalescing or asynchronous policy checks. */
  readonly responseBindings: readonly ResponseSubmittedData[];
}

export function admitDeliveries(input: {
  /** The delivery as the session accepted it. */
  readonly delivery: DeliverHookPayload;
  /** The payloads left once sign-in callbacks were matched out, with what `deliver` made of each. */
  readonly payloads: readonly {
    readonly payload: DeliverPayload;
    readonly input: StepInput | undefined;
  }[];
  /** The position of the line the admission takes, for ids a delivery arrived without. */
  readonly position: number;
  /** Whether the session already admitted a delivery, as when it forwarded part of it. */
  readonly admitted?: (deliveryId: string) => boolean;
  readonly channelKind: string;
}): DeliveryAdmission {
  const { delivery } = input;
  const facts: SessionEvent[] = [];
  const consumed: ConsumedDelivery[] = [];
  const responseBindings: ResponseSubmittedData[] = [];
  const principal = principalOf(delivery.auth);
  for (const { input: stepInput, payload } of input.payloads) {
    const index = delivery.payloads.indexOf(payload);
    const metadata = delivery.deliveryMetadata?.find((entry) => entry.payloadIndex === index);
    const deliveryId =
      metadata?.deliveryId ?? `delivery_${String(input.position)}_${String(index)}`;
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
    consumed.push({
      deliveryId,
      parts: stepInput.message === undefined ? [] : userPartsOf(stepInput.message),
    });
    for (const [answerIndex, answer] of (stepInput.inputResponses ?? []).entries()) {
      const value: { -readonly [K in keyof ResponseValue]: ResponseValue[K] } = {};
      if (answer.optionId !== undefined) value.optionId = answer.optionId;
      if (answer.text !== undefined) value.text = answer.text;
      responseBindings.push({
        responseId: `response_${deliveryId}_${answerIndex}`,
        interactionId: answer.requestId,
        deliveryId,
        value,
      });
    }
  }
  return { consumed, facts, responseBindings };
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
