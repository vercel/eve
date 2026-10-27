import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id, principal, userPart, known } from "../common.js";
import type { Envelope, Principal, UserPart } from "../envelope.js";

/**
 * Where a delivery came from: a channel (with the schedule that sent it), a control, or a
 * sign-in callback. The set is open. A parent session records which of its calls sent a child's
 * delivery on its own `child.sent`.
 */
export type DeliverySource =
  | { readonly channel: string; readonly scheduleId?: string }
  | { readonly control: string }
  | { readonly callback: string };

export interface DeliveryAdmittedData {
  readonly deliveryId: string;
  /** Absent for deliveries without auth, such as a sign-in callback. */
  readonly principal?: Principal;
  readonly source?: DeliverySource;
}

/**
 * A message from conversation eve did not run, such as a transcript an app stored. It is text
 * only: it names no turn or call, and records nothing eve did.
 */
export interface ImportedMessage {
  /** The app's own id for the message, when it gave one. eve never reads it. */
  readonly id?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface DeliveryConsumedData {
  readonly deliveryId: string;
  readonly turnId: string;
  /** What the person sent. Empty for a delivery that only adds context. */
  readonly parts: readonly UserPart[];
  /**
   * Earlier conversation the delivery brought, oldest first. The model reads the history of the
   * deliveries a line consumes before what they sent.
   */
  readonly history?: readonly ImportedMessage[];
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
      channel: z.string(),
      scheduleId: z.string().optional(),
    }),
    z.object({ control: z.string() }),
    z.object({ callback: z.string() }),
  ]),
);

const importedMessage = conforming<ImportedMessage>()(
  z.object({ id: z.string().optional(), role: z.enum(["user", "assistant"]), text: z.string() }),
);

export const deliverySchemas = {
  "delivery.admitted": envelopeOf(
    "delivery.admitted",
    conforming<DeliveryAdmittedData>()(
      z.object({
        deliveryId: id,
        principal: principal.optional(),
        source: deliverySource.optional(),
      }),
    ),
  ),
  "delivery.consumed": envelopeOf(
    "delivery.consumed",
    conforming<DeliveryConsumedData>()(
      z.object({
        deliveryId: id,
        history: z.array(importedMessage).optional(),
        parts: z.array(userPart),
        turnId: id,
      }),
    ),
  ),
  "delivery.settled": envelopeOf(
    "delivery.settled",
    conforming<DeliverySettledData>()(
      z.object({
        deliveryId: id,
        outcome: known<DeliveryOutcome>(),
        reason: z.string().optional(),
        turnId: id.optional(),
      }),
    ),
  ),
};
