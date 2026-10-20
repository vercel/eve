// Public interaction and response facts from the runtime's private request records. They say
// what a person is asked and what decided it; call actions, credentials, and answer routes stay
// private.

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { defined, fact } from "#harness/facts.js";
import type { Cause } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
  InteractionRequest,
  InteractionSubject,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import type {
  ResponseOutcome,
  ResponseSubmittedData,
  ResponseValue,
} from "#protocol/session-events/families/response.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

/**
 * A question, approval, or budget prompt opens. An approval is about its call, a budget prompt
 * about its turn; a relayed request names the serving call or task it arrived through.
 */
export function interactionOpened(input: {
  readonly interactionId: string;
  readonly request: InteractionRequest;
  readonly subject: InteractionSubject;
  readonly origin?: InteractionOpenedData["origin"];
  readonly audience?: InteractionOpenedData["audience"];
}): FactOf<"interaction.opened"> {
  const { audience, interactionId, origin, request, subject } = input;
  return fact("interaction.opened", { audience, interactionId, origin, request, subject });
}

/** An approval opens about its call. */
export function approvalOpened(ask: ApprovalAsk): FactOf<"interaction.opened"> {
  return interactionOpened({
    interactionId: ask.interactionId,
    request: ask.request,
    subject: { callId: ask.call.callId },
  });
}

/** The interaction a sign-in attempt is: its attempt id, or its connection name without one. */
export function signInInteractionId(
  challenge: Pick<AuthorizationChallenge, "attemptId" | "name">,
): string {
  return challenge.attemptId ?? challenge.name;
}

/** A sign-in's public challenge. Provider callback payloads and credential resolvers stay private. */
export function signInOpened(
  challenge: AuthorizationChallenge,
  input: {
    readonly subject: InteractionSubject;
    readonly origin?: InteractionOpenedData["origin"];
    readonly prompt?: string;
  },
): FactOf<"interaction.opened"> {
  const details = challenge.challenge;
  const signIn: SignInChallenge = defined({
    callbackUrl: challenge.hookUrl,
    displayName: details.displayName,
    expiresAt: details.expiresAt,
    // Who and what it grants, so a later call can tell it asks for the same sign-in.
    grant: challenge.grant,
    instructions: details.instructions,
    name: challenge.name,
    principal: signInPrincipal(challenge.principal),
    url: details.url,
    userCode: details.userCode,
  });
  const request: InteractionRequest = defined({
    kind: "sign-in",
    link: details.url === undefined ? undefined : { url: details.url },
    prompt: input.prompt ?? details.instructions ?? `Authorization required for ${challenge.name}`,
    signIn,
  });
  return fact("interaction.opened", {
    audience:
      challenge.principalId === undefined ? undefined : { principalIds: [challenge.principalId] },
    interactionId: signInInteractionId(challenge),
    origin: input.origin,
    request,
    subject: input.subject,
  });
}

/** The principal's identity: its attributes stay out of the stream, which every client reads. */
function signInPrincipal(principal: ConnectionPrincipal | undefined): SignInChallenge["principal"] {
  if (principal === undefined) return undefined;
  if (principal.type === "app") return { type: "app" };
  return principal.issuer === undefined
    ? { id: principal.id, type: "user" }
    : { id: principal.id, issuer: principal.issuer, type: "user" };
}

/** An interaction ends. `cause` names the response that decided it, or what else settled it. */
export function interactionSettled(
  interactionId: string,
  outcome: InteractionOutcome,
  input: {
    readonly reason?: string;
    readonly cause?: Cause;
    readonly response?: ResponseValue;
  } = {},
): FactOf<"interaction.settled"> {
  const response =
    input.response === undefined
      ? undefined
      : defined<{ optionId?: string; text?: string }>({
          optionId: input.response.optionId,
          text: input.response.text,
        });
  return fact("interaction.settled", {
    cause: input.cause,
    interactionId,
    outcome,
    reason: input.reason,
    response: response !== undefined && Object.keys(response).length > 0 ? response : undefined,
  });
}

export function responseSubmitted(binding: ResponseSubmittedData): FactOf<"response.submitted"> {
  const { deliveryId, interactionId, responseId, value } = binding;
  return fact("response.submitted", {
    deliveryId,
    interactionId,
    responseId,
    value: value !== undefined && Object.keys(value).length > 0 ? value : undefined,
  });
}

export function responseAdmitted(responseId: string): FactOf<"response.admitted"> {
  return { type: "response.admitted", data: { responseId } };
}

export function responseSettled(
  responseId: string,
  outcome: ResponseOutcome,
  reason?: string,
): FactOf<"response.settled"> {
  return fact("response.settled", { outcome, reason, responseId });
}
