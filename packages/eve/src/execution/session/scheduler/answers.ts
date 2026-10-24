import type { DeliverHookPayload } from "#channel/types.js";
import {
  heldDelivery,
  isSteeringDelivery,
  replaceDelivery,
  type Held,
  type SteeringTurn,
} from "#execution/session/scheduler/held.js";
import { inTurn, without, type Scheduler, type Turn } from "#execution/session/scheduler/state.js";
import { selectDeliveryPayloads } from "#harness/messages.js";

// What a waiting turn takes of a delivery that answers what it asks: anyone may answer, but only
// the turn's own person steers it, so anyone else's message waits for the turn to end.

/**
 * The first delivery the turn admitted that answers what it asks: an approver need not be the
 * turn's own person. One that answers only other requests may still answer these once its
 * channel maps its ids (`others`), such as Telegram's compact button callbacks, which only its
 * `deliver` hook resolves; the turn tries that once per delivery.
 */
export function firstAnswering(
  held: Held,
  turn: Turn,
  requestIds: ReadonlySet<string>,
):
  | {
      readonly kind: "answers" | "others";
      readonly sequence: number;
      readonly delivery: DeliverHookPayload;
    }
  | undefined {
  for (const sequence of turn.admitted) {
    const delivery = heldDelivery(held, sequence);
    if (delivery === undefined) continue;
    const answers = answersIn(delivery, requestIds);
    if (answers === "answers") return { delivery, kind: "answers", sequence };
    if (answers === "others" && !turn.mapped.includes(sequence))
      return { delivery, kind: "others", sequence };
  }
  return undefined;
}

/** The turn takes the delivery at `sequence` that answers it, and leaves the rest held. */
export function takeAnswering(
  state: Scheduler,
  turn: Turn,
  sequence: number,
  delivery: DeliverHookPayload,
): Scheduler {
  const taken = takenAnswers(delivery, turn.steerer);
  return inTurn(
    { ...state, held: replaceDelivery(state.held, sequence, taken.rest) },
    {
      ...turn,
      admitted: without(turn.admitted, [sequence]),
      at: { input: { delivery: taken.answers }, kind: "step" },
    },
  );
}

/**
 * Whether a held delivery answers what a paused turn asks: some of its answers do, it answers
 * only other requests (`others`, which a channel's ids may still map onto these), or it carries
 * no answers.
 */
function answersIn(
  delivery: DeliverHookPayload,
  requestIds: ReadonlySet<string>,
): "answers" | "others" | "none" {
  const responses = delivery.payloads.flatMap((payload) => payload.answers ?? []);
  if (responses.length === 0) return "none";
  return responses.some((response) => requestIds.has(response.interactionId))
    ? "answers"
    : "others";
}

/**
 * What a paused turn takes of a delivery that answers it: all of it from the turn's own person,
 * whose message steers it, and from anyone else only the answers, which settle the request,
 * while the rest of their delivery waits for the turn to end, as their messages do.
 */
function takenAnswers(
  delivery: DeliverHookPayload,
  turn: SteeringTurn,
): { readonly answers: DeliverHookPayload; readonly rest?: DeliverHookPayload } {
  if (isSteeringDelivery(delivery, turn, { heldOnPerson: true })) return { answers: delivery };
  const answers = delivery.payloads.flatMap((payload, index) =>
    payload.answers === undefined ? [] : [{ index, payload: { answers: payload.answers } }],
  );
  const rest = delivery.payloads.flatMap((payload, index) => {
    if (payload.message === undefined) return [];
    const { answers: _answers, ...other } = payload;
    return [{ index, payload: other }];
  });
  if (rest.length === 0) return { answers: delivery };
  // A payload whose answers go now and whose message waits is two deliveries on the stream:
  // the message keeps the payload's identity, and the answers taken now get their own, so each
  // is admitted once and ends once.
  const split = new Set(rest.map(({ index }) => index));
  const taken = selectDeliveryPayloads(delivery, answers);
  return {
    answers: {
      ...taken,
      deliveryMetadata: taken.deliveryMetadata?.map((entry) =>
        split.has(answers[entry.payloadIndex]!.index)
          ? { ...entry, deliveryId: answersDeliveryId(entry.deliveryId) }
          : entry,
      ),
    },
    rest: selectDeliveryPayloads(delivery, rest),
  };
}

/** The delivery the answers of a payload whose message waits are taken as. */
export function answersDeliveryId(deliveryId: string): string {
  return `answers_${deliveryId}`;
}
