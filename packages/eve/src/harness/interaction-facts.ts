// Public interaction and response facts from the runtime's private request records. They say
// what a person is asked and what decided it; call actions, credentials, and answer routes stay
// private.

import type { AuthorizationChallenge } from "#harness/authorization.js";
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
import type { ApprovalAsk } from "#harness/session-machine/state.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
  const data: Mutable<InteractionOpenedData> = {
    interactionId: input.interactionId,
    request: input.request,
    subject: input.subject,
  };
  if (input.origin !== undefined) data.origin = input.origin;
  if (input.audience !== undefined) data.audience = input.audience;
  return { type: "interaction.opened", data };
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
  const visible: Mutable<SignInChallenge> = { name: challenge.name };
  const details = challenge.challenge;
  if (details.displayName !== undefined) visible.displayName = details.displayName;
  if (details.url !== undefined) visible.url = details.url;
  if (details.userCode !== undefined) visible.userCode = details.userCode;
  if (details.expiresAt !== undefined) visible.expiresAt = details.expiresAt;
  if (details.instructions !== undefined) visible.instructions = details.instructions;
  if (challenge.hookUrl !== undefined) visible.callbackUrl = challenge.hookUrl;
  // Who and what it grants, so a later call can tell it asks for the same sign-in.
  if (challenge.grant !== undefined) visible.grant = challenge.grant;
  const principal = signInPrincipal(challenge.principal);
  if (principal !== undefined) visible.principal = principal;
  const request: Mutable<InteractionRequest> = {
    kind: "sign-in",
    prompt: input.prompt ?? details.instructions ?? `Authorization required for ${challenge.name}`,
    signIn: visible,
  };
  if (details.url !== undefined) request.link = { url: details.url };
  const data: Mutable<InteractionOpenedData> = {
    interactionId: signInInteractionId(challenge),
    request,
    subject: input.subject,
  };
  if (challenge.principalId !== undefined)
    data.audience = { principalIds: [challenge.principalId] };
  if (input.origin !== undefined) data.origin = input.origin;
  return { type: "interaction.opened", data };
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
  const data: Mutable<FactOf<"interaction.settled">["data"]> = { interactionId, outcome };
  if (input.reason !== undefined) data.reason = input.reason;
  if (input.cause !== undefined) data.cause = input.cause;
  if (input.response !== undefined) {
    const detail: { optionId?: string; text?: string } = {};
    if (input.response.optionId !== undefined) detail.optionId = input.response.optionId;
    if (input.response.text !== undefined) detail.text = input.response.text;
    if (Object.keys(detail).length > 0) data.response = detail;
  }
  return { type: "interaction.settled", data };
}

export function responseSubmitted(binding: ResponseSubmittedData): FactOf<"response.submitted"> {
  const data: Mutable<ResponseSubmittedData> = {
    deliveryId: binding.deliveryId,
    interactionId: binding.interactionId,
    responseId: binding.responseId,
  };
  if (binding.value !== undefined && Object.keys(binding.value).length > 0)
    data.value = binding.value;
  return { type: "response.submitted", data };
}

export function responseAdmitted(responseId: string): FactOf<"response.admitted"> {
  return { type: "response.admitted", data: { responseId } };
}

export function responseSettled(
  responseId: string,
  outcome: ResponseOutcome,
  reason?: string,
): FactOf<"response.settled"> {
  return reason === undefined
    ? { type: "response.settled", data: { outcome, responseId } }
    : { type: "response.settled", data: { outcome, reason, responseId } };
}
