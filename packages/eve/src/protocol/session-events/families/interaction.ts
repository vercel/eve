import { z } from "#compiled/zod/index.js";

import { cause, conforming, envelopeOf, id, jsonValue, known } from "../common.js";
import type { Cause, Envelope, JsonValue } from "../envelope.js";

/** What an interaction is about. */
export type InteractionSubject =
  | { readonly callId: string }
  | { readonly turnId: string }
  | { readonly taskId: string }
  | { readonly responseId: string };

/**
 * What kind of thing a person is asked. A newer eve can add a kind: a reader shows one it doesn't
 * know from the common fields, so its switch keeps a default branch.
 */
export type InteractionKind = "approval" | "question" | "sign-in" | "budget";

/** How a request suggests showing its choices. A hint: a newer eve can add one. */
export type InteractionDisplay = "confirmation" | "select" | "text";

/** How an option suggests looking. A hint: a newer eve can add one. */
export type InteractionOptionStyle = "primary" | "danger" | "default";

export interface InteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: InteractionOptionStyle;
}

/**
 * What a person is asked. Every request renders from the common fields, so a reader that doesn't
 * know a kind can still show it and answer through options, free text, or the link.
 */
export interface InteractionRequest {
  readonly kind: InteractionKind;
  readonly prompt: string;
  readonly title?: string;
  readonly options?: readonly InteractionOption[];
  readonly allowFreeform?: boolean;
  readonly display?: InteractionDisplay;
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
  /** The credential the sign-in grants, shared by every connection or tool that uses it. */
  readonly grant?: string;
  /**
   * The connection principal the sign-in is for, without its attributes. `type` is open:
   * `"user"`, which has an `id`, and `"app"` today.
   */
  readonly principal?: { readonly type: string; readonly id?: string; readonly issuer?: string };
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

/** Zod schema for what a person is asked. */
export const interactionRequestSchema = conforming<InteractionRequest>()(
  z.object({
    allowFreeform: z.boolean().optional(),
    display: known<InteractionDisplay>().optional(),
    kind: known<InteractionKind>(),
    link: z.object({ label: z.string().optional(), url: z.string() }).optional(),
    options: z
      .array(
        z.object({
          description: z.string().optional(),
          id: z.string(),
          label: z.string(),
          style: known<InteractionOptionStyle>().optional(),
        }),
      )
      .optional(),
    prompt: z.string(),
    signIn: z
      .object({
        callbackUrl: z.string().optional(),
        displayName: z.string().optional(),
        expiresAt: z.string().optional(),
        grant: z.string().optional(),
        instructions: z.string().optional(),
        name: z.string(),
        principal: z
          .object({ id: z.string().optional(), issuer: z.string().optional(), type: z.string() })
          .optional(),
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
        request: interactionRequestSchema,
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
        outcome: known<InteractionOutcome>(),
        reason: z.string().optional(),
        response: z.record(z.string(), jsonValue).optional(),
      }),
    ),
  ),
};
