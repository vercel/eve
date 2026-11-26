import { z } from "#compiled/zod/index.js";

import {
  conforming,
  envelopeOf,
  id,
  jsonObject,
  jsonValue,
  principal,
  userPart,
  known,
} from "../common.js";
import type { Envelope, JsonObject, JsonValue, Principal, UserPart } from "../envelope.js";

/**
 * Where a delivery came from: a channel (with the schedule or hook that sent it), a control, or a
 * sign-in callback. A hook's `ctx.continue()` names the hook's slug and the session's channel.
 * The set is open. A parent session records which of its calls sent a child's delivery on its own
 * `child.sent`.
 */
export type DeliverySource =
  | { readonly channel: string; readonly scheduleId?: string; readonly hook?: string }
  | { readonly control: string }
  | { readonly callback: string };

/** The payload of `delivery.admitted`: the session accepted a delivery, with who sent it and from where. */
export interface DeliveryAdmittedData {
  readonly deliveryId: string;
  /** Absent for deliveries without auth, such as a sign-in callback. */
  readonly principal?: Principal;
  readonly source?: DeliverySource;
}

/** A text part recorded on an {@link ImportedMessage}. */
export interface ImportedTextPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * A completed tool call recorded on an {@link ImportedMessage}. eve did not run it, so the stream
 * has no `call.*` facts for it. Carries either `output` or `error`.
 */
export type ImportedToolPart = {
  readonly type: "tool";
  readonly name: string;
  /** The call's JSON object input. Absent when omitted on import, which the model reads as `{}`. */
  readonly input?: JsonObject;
} & (
  | {
      /** The result the model reads for a completed call. */
      readonly output: JsonValue;
      readonly error?: never;
    }
  | {
      readonly output?: never;
      /** The error message the model reads for a failed call. */
      readonly error: string;
    }
);

/** One structured part recorded on an {@link ImportedMessage}. */
export type ImportedPart = ImportedTextPart | ImportedToolPart;

/**
 * A message from conversation eve did not run, such as a transcript an app stored. It names no
 * turn or call, and records nothing eve ran.
 */
export interface ImportedMessage {
  /** The app's own id for the message, when it gave one. eve never reads it. */
  readonly id?: string;
  readonly role: "user" | "assistant";
  /**
   * The message's plain text. When `parts` is present, holds the message's text parts joined by
   * newlines, or `""` for a tool-only assistant entry.
   */
  readonly text: string;
  /** Ordered structured parts when the message was imported with `parts`. */
  readonly parts?: readonly ImportedPart[];
}

/** The payload of `delivery.consumed`: a turn took in a delivery and what the person sent. */
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

/** How a delivery ended, as recorded on `delivery.settled`. */
export type DeliveryOutcome =
  | "handled"
  | "awaiting-input"
  | "applied"
  | "ignored"
  | "refused"
  | "failed";

/** The payload of `delivery.settled`: a delivery ends, with its outcome. */
export interface DeliverySettledData {
  readonly deliveryId: string;
  readonly outcome: DeliveryOutcome;
  /** The turn whose reply answers the delivery, when it started or joined one. */
  readonly turnId?: string;
  readonly reason?: string;
}

/** The fact that introduces a delivery. */
export type DeliveryAdmitted = Envelope<"delivery.admitted", DeliveryAdmittedData>;
/** The fact recording that a turn consumed a delivery. */
export type DeliveryConsumed = Envelope<"delivery.consumed", DeliveryConsumedData>;
/** The terminal fact of a delivery. */
export type DeliverySettled = Envelope<"delivery.settled", DeliverySettledData>;
/** Any fact in the `delivery` family. */
export type DeliveryFact = DeliveryAdmitted | DeliveryConsumed | DeliverySettled;

const deliverySource = conforming<DeliverySource>()(
  z.union([
    z.object({
      channel: z.string(),
      scheduleId: z.string().optional(),
      hook: z.string().optional(),
    }),
    z.object({ control: z.string() }),
    z.object({ callback: z.string() }),
  ]),
);

const importedTextPart = conforming<ImportedTextPart>()(
  z.object({ text: z.string(), type: z.literal("text") }),
);

const importedToolPart = conforming<ImportedToolPart>()(
  z.union([
    z.object({
      error: z.never().optional(),
      input: jsonObject.optional(),
      name: z.string(),
      output: jsonValue,
      type: z.literal("tool"),
    }),
    z.object({
      error: z.string(),
      input: jsonObject.optional(),
      name: z.string(),
      output: z.never().optional(),
      type: z.literal("tool"),
    }),
  ]),
);

const importedPart = conforming<ImportedPart>()(z.union([importedTextPart, importedToolPart]));

const importedMessage = conforming<ImportedMessage>()(
  z.object({
    id: z.string().optional(),
    parts: z.array(importedPart).optional(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  }),
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
