import { z } from "#compiled/zod/index.js";

import { DELIVERY_OUTCOMES } from "../catalog.js";
import { conforming, envelopeOf, id, jsonValue, principal, userPart } from "../common.js";
import type { Envelope, JsonValue, Principal, UserPart } from "../envelope.js";

/**
 * Where a delivery came from: a channel (with the schedule or calling session that sent it), a
 * control, or a sign-in callback. The set is open.
 */
export type DeliverySource =
  | {
      readonly channel: string;
      readonly scheduleId?: string;
      readonly caller?: { readonly sessionId: string; readonly callId?: string };
    }
  | { readonly control: string }
  | { readonly callback: string };

export interface DeliveryAdmittedData {
  readonly deliveryId: string;
  /** Absent for deliveries without auth, such as a sign-in callback. */
  readonly principal?: Principal;
  readonly source?: DeliverySource;
  readonly clientContext?: JsonValue;
}

export interface DeliveryConsumedData {
  readonly deliveryId: string;
  readonly turnId: string;
  /** What the person sent. Empty for a delivery that only adds context. */
  readonly parts: readonly UserPart[];
}

export type DeliveryOutcome =
  | "handled"
  | "awaiting-input"
  | "applied"
  | "ignored"
  | "refused"
  | "failed";

export interface DeliverySettledData {
  readonly deliveryId: string;
  readonly outcome: DeliveryOutcome;
  /** The turn whose reply answers the delivery, when it started or joined one. */
  readonly turnId?: string;
  readonly reason?: string;
}

export type DeliveryAdmitted = Envelope<"delivery.admitted", DeliveryAdmittedData>;
export type DeliveryConsumed = Envelope<"delivery.consumed", DeliveryConsumedData>;
export type DeliverySettled = Envelope<"delivery.settled", DeliverySettledData>;
export type DeliveryFact = DeliveryAdmitted | DeliveryConsumed | DeliverySettled;

const deliverySource = conforming<DeliverySource>()(
  z.union([
    z.object({
      caller: z.object({ callId: id.optional(), sessionId: id }).optional(),
      channel: z.string(),
      scheduleId: z.string().optional(),
    }),
    z.object({ control: z.string() }),
    z.object({ callback: z.string() }),
  ]),
);

export const deliverySchemas = {
  "delivery.admitted": envelopeOf(
    "delivery.admitted",
    conforming<DeliveryAdmittedData>()(
      z.object({
        clientContext: jsonValue.optional(),
        deliveryId: id,
        principal: principal.optional(),
        source: deliverySource.optional(),
      }),
    ),
  ),
  "delivery.consumed": envelopeOf(
    "delivery.consumed",
    conforming<DeliveryConsumedData>()(
      z.object({ deliveryId: id, parts: z.array(userPart), turnId: id }),
    ),
  ),
  "delivery.settled": envelopeOf(
    "delivery.settled",
    conforming<DeliverySettledData>()(
      z.object({
        deliveryId: id,
        outcome: z.enum(DELIVERY_OUTCOMES),
        reason: z.string().optional(),
        turnId: id.optional(),
      }),
    ),
  ),
};
