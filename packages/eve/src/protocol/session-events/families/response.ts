import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id, known } from "../common.js";
import type { Envelope } from "../envelope.js";

/** A person's answer. A sign-in callback's response carries none: its payload stays private. */
export interface ResponseValue {
  readonly optionId?: string;
  readonly text?: string;
}

/**
 * A person's answer to an interaction: the option they chose, what they wrote, or both. It's
 * what a client submits and what `response.submitted` records as the response's value.
 */
export interface Answer extends ResponseValue {
  readonly interactionId: string;
}

/** The payload of `response.submitted`: a person's answer to an interaction arrived. */
export interface ResponseSubmittedData {
  readonly responseId: string;
  readonly interactionId: string;
  /** The delivery the answer arrived in; its principal is who answered. */
  readonly deliveryId: string;
  readonly value?: ResponseValue;
}

/** The payload of `response.admitted`: the session accepted a submitted response. */
export interface ResponseAdmittedData {
  readonly responseId: string;
}

/** How a response ended, as recorded on `response.settled`. */
export type ResponseOutcome =
  | "applied"
  | "refused"
  | "failed"
  | "withdrawn"
  | "abandoned"
  | "expired";

/** The payload of `response.settled`: a response ends, with its outcome. */
export interface ResponseSettledData {
  readonly responseId: string;
  readonly outcome: ResponseOutcome;
  readonly reason?: string;
}

/** The fact that introduces a response. */
export type ResponseSubmitted = Envelope<"response.submitted", ResponseSubmittedData>;
/** The fact recording that the session accepted a response. */
export type ResponseAdmitted = Envelope<"response.admitted", ResponseAdmittedData>;
/** The terminal fact of a response. */
export type ResponseSettled = Envelope<"response.settled", ResponseSettledData>;
/** Any fact in the `response` family. */
export type ResponseFact = ResponseSubmitted | ResponseAdmitted | ResponseSettled;

export const responseSchemas = {
  "response.admitted": envelopeOf(
    "response.admitted",
    conforming<ResponseAdmittedData>()(z.object({ responseId: id })),
  ),
  "response.settled": envelopeOf(
    "response.settled",
    conforming<ResponseSettledData>()(
      z.object({
        outcome: known<ResponseOutcome>(),
        reason: z.string().optional(),
        responseId: id,
      }),
    ),
  ),
  "response.submitted": envelopeOf(
    "response.submitted",
    conforming<ResponseSubmittedData>()(
      z.object({
        deliveryId: id,
        interactionId: id,
        responseId: id,
        value: z
          .object({ optionId: z.string().optional(), text: z.string().optional() })
          .optional(),
      }),
    ),
  ),
};
