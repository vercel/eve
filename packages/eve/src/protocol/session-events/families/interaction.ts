import { z } from "#compiled/zod/index.js";

import { INTERACTION_OUTCOMES } from "../catalog.js";
import { cause, conforming, envelopeOf, id, jsonValue } from "../common.js";
import type { Cause, Envelope, JsonValue } from "../envelope.js";

/** What an interaction is about. */
export type InteractionSubject =
  | { readonly callId: string }
  | { readonly turnId: string }
  | { readonly taskId: string }
  | { readonly responseId: string };

export interface InteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** A rendering hint: `primary`, `danger`, or `default`. Open. */
  readonly style?: string;
}

/**
 * What a person is asked. Every request renders from the common fields, so a reader that doesn't
 * know a kind can still show it and answer through options, free text, or the link.
 */
export interface InteractionRequest {
  /** Open: `approval`, `question`, `sign-in`, and `budget` today. */
  readonly kind: "approval" | "question" | "sign-in" | "budget" | (string & {});
  readonly prompt: string;
  readonly title?: string;
  readonly options?: readonly InteractionOption[];
  readonly allowFreeform?: boolean;
  /** A rendering hint: `confirmation`, `select`, or `text`. Open. */
  readonly display?: string;
  readonly link?: { readonly url: string; readonly label?: string };
  /** A sign-in's challenge. */
  readonly signIn?: SignInChallenge;
}

/** What a sign-in asks the person to do, visible to the same readers as today. */
export interface SignInChallenge {
  /** The connection or tool that needs the sign-in. */
  readonly name: string;
  readonly displayName?: string;
  readonly url?: string;
  readonly userCode?: string;
  readonly expiresAt?: string;
  readonly instructions?: string;
  readonly callbackUrl?: string;
}

/** Where a relayed request was asked: the child session's request, and the call it asks about. */
export interface InteractionOrigin {
  readonly sessionId: string;
  readonly interactionId: string;
  /**
   * The asker's call, when it asks about one, such as the tool a child wants approved. This
   * session's tables hold only the call that delegated to the child.
   */
  readonly call?: { readonly callId: string; readonly name: string; readonly input?: JsonValue };
}

export interface InteractionOpenedData {
  readonly interactionId: string;
  readonly subject: InteractionSubject;
  readonly request: InteractionRequest;
  /** The child session's request this one relays. */
  readonly origin?: InteractionOrigin;
  /** Who the request is for, such as the principal that started a sign-in. */
  readonly audience?: { readonly principalIds: readonly string[] };
}

export type InteractionOutcome =
  | "accepted"
  | "declined"
  | "invalid"
  | "failed"
  | "withdrawn"
  | "interrupted"
  | "abandoned"
  | "expired";

export interface InteractionSettledData {
  readonly interactionId: string;
  readonly outcome: InteractionOutcome;
  /** Open, such as `superseded-by-message` for a withdrawal. */
  readonly reason?: string;
  /** The response that decided it, or what else settled it. */
  readonly cause?: Cause;
  /** Kind-specific detail of the outcome, such as the chosen option. */
  readonly response?: { readonly [key: string]: JsonValue };
}

export type InteractionOpened = Envelope<"interaction.opened", InteractionOpenedData>;
export type InteractionSettled = Envelope<"interaction.settled", InteractionSettledData>;
export type InteractionFact = InteractionOpened | InteractionSettled;

const subject = conforming<InteractionSubject>()(
  z.union([
    z.object({ callId: id }),
    z.object({ turnId: id }),
    z.object({ taskId: id }),
    z.object({ responseId: id }),
  ]),
);

const request = conforming<InteractionRequest>()(
  z.object({
    allowFreeform: z.boolean().optional(),
    display: z.string().optional(),
    kind: z.string(),
    link: z.object({ label: z.string().optional(), url: z.string() }).optional(),
    options: z
      .array(
        z.object({
          description: z.string().optional(),
          id: z.string(),
          label: z.string(),
          style: z.string().optional(),
        }),
      )
      .optional(),
    prompt: z.string(),
    signIn: z
      .object({
        callbackUrl: z.string().optional(),
        displayName: z.string().optional(),
        expiresAt: z.string().optional(),
        instructions: z.string().optional(),
        name: z.string(),
        url: z.string().optional(),
        userCode: z.string().optional(),
      })
      .optional(),
    title: z.string().optional(),
  }),
);

export const interactionSchemas = {
  "interaction.opened": envelopeOf(
    "interaction.opened",
    conforming<InteractionOpenedData>()(
      z.object({
        audience: z.object({ principalIds: z.array(z.string()) }).optional(),
        interactionId: id,
        origin: z
          .object({
            call: z
              .object({ callId: id, input: jsonValue.optional(), name: z.string() })
              .optional(),
            interactionId: id,
            sessionId: id,
          })
          .optional(),
        request,
        subject,
      }),
    ),
  ),
  "interaction.settled": envelopeOf(
    "interaction.settled",
    conforming<InteractionSettledData>()(
      z.object({
        cause: cause.optional(),
        interactionId: id,
        outcome: z.enum(INTERACTION_OUTCOMES),
        reason: z.string().optional(),
        response: z.record(z.string(), jsonValue).optional(),
      }),
    ),
  ),
};
